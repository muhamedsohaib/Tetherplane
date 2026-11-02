import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const defaultFiles = [
  "tetherd.exe", "tetherd-agentw.exe", "tetherplane-browserw.exe",
  "tetherplane-modelw.exe", "tetherplane-setupw.exe", "tetherplane-autostartw.exe",
];
const banned = /^(?:vcruntime(?:\d+)?(?:_\d+)?|msvcp\d+|msvcr\d+|concrt\d+|vccorlib\d+)\.dll$/i;

function importsFor(file) {
  const b = readFileSync(file);
  const safe = (o, n) => {
    if (!Number.isSafeInteger(o) || o < 0 || o + n > b.length) throw Error("Invalid PE bounds");
    return o;
  };
  const u16 = o => b.readUInt16LE(safe(o, 2));
  const u32 = o => b.readUInt32LE(safe(o, 4));
  assert.equal(b.toString("ascii", safe(0, 2), 2), "MZ", "Missing MZ");
  const pe = u32(0x3c);
  assert.equal(b.toString("ascii", safe(pe, 4), pe + 4), "PE\u0000\u0000", "Missing PE");
  const coff = pe + 4;
  const nSections = u16(coff + 2);
  const optSize = u16(coff + 16);
  const opt = coff + 20;
  safe(opt, optSize);
  const magic = u16(opt);
  assert.ok(magic === 0x20b || magic === 0x10b, "Unsupported PE architecture");
  const dirStart = opt + (magic === 0x20b ? 112 : 96);
  const dirCount = u32(opt + (magic === 0x20b ? 108 : 92));
  const table = opt + optSize;
  safe(table, nSections * 40);
  const sections = Array.from({ length: nSections }, (_, i) => {
    const s = table + i * 40;
    return { virtual: u32(s + 12), vSize: u32(s + 8), size: u32(s + 16), raw: u32(s + 20) };
  });
  function rvaOffset(rva) {
    for (const s of sections) {
      if (rva >= s.virtual && rva < s.virtual + Math.max(s.size, s.vSize)) {
        const delta = rva - s.virtual;
        if (delta >= s.size) throw Error("PE import references unmapped bytes");
        return safe(s.raw + delta, 1);
      }
    }
    throw Error("PE import RVA not contained in image section");
  }
  function cString(rva) {
    const start = rvaOffset(rva);
    const end = b.indexOf(0, start);
    if (end < start || end - start > 255) throw Error("Invalid PE DLL name");
    return b.toString("ascii", start, end);
  }
  function directory(i) {
    if (dirCount <= i) return null;
    const o = dirStart + i * 8;
    if (o + 8 > opt + optSize) throw Error("Truncated PE data directory");
    const rva = u32(o), size = u32(o + 4);
    return rva && size ? { rva, size } : null;
  }
  const imports = [];
  const regular = directory(1);
  if (regular) {
    const start = rvaOffset(regular.rva);
    let ended = false;
    for (let i = 0; i < 8192; i++) {
      const p = safe(start + i * 20, 20);
      const first = u32(p), date = u32(p + 4), name = u32(p + 12), thunk = u32(p + 16);
      if (!first && !date && !name && !thunk) { ended = true; break; }
      if (!name) throw Error("Empty import descriptor");
      imports.push(cString(name));
    }
    if (!ended) throw Error("Unterminated import descriptors");
  }
  const delay = directory(13);
  if (delay) {
    const start = rvaOffset(delay.rva);
    let ended = false;
    for (let i = 0; i < 8192; i++) {
      const p = safe(start + i * 32, 32);
      const flags = u32(p), name = u32(p + 4);
      if (!flags && !name) { ended = true; break; }
      if (flags !== 1 || !name) throw Error("Unsupported PE delay import format");
      imports.push(cString(name));
    }
    if (!ended) throw Error("Unterminated delay import descriptors");
  }
  if (!regular && !delay) throw Error("No native PE dependencies found");
  return imports;
}

assert.ok(process.argv.length >= 3, "Usage: node windows-native-runtime-imports.mjs <bin-dir> [optional-exe-names]");
const dir = resolve(process.argv[2]);
const files = process.argv.length > 3 ? process.argv.slice(3) : defaultFiles;
for (const file of files) {
  assert.match(file, /^[A-Za-z0-9-]+\.exe$/i, "Expected executable basename");
  const imports = importsFor(join(dir, file));
  const nonInbox = imports.filter(name => banned.test(name));
  console.log("WINDOWS_NATIVE_IMPORTS " + file + ": " + imports.join(","));
  assert.deepEqual(nonInbox, [], file + " imports VC redistributable DLL(s): " + nonInbox.join(","));
}
console.log("WINDOWS_NATIVE_STATIC_CRT_IMPORTS_OK count=" + files.length);
