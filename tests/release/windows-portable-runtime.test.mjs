import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inspectPeImports } from "../../scripts/windows/check-pe-runtime-imports.mjs";

const auditPath = fileURLToPath(
  new URL("../../scripts/windows/check-pe-runtime-imports.mjs", import.meta.url),
);
const read = (relative) => readFileSync(new URL("../../" + relative, import.meta.url), "utf8");

function samplePe(normalDlls, delayedDlls = []) {
  const buf = Buffer.alloc(0x1800);
  buf.write("MZ", 0, "ascii");
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80, "ascii");
  buf.writeUInt16LE(0x8664, 0x84);
  buf.writeUInt16LE(1, 0x86); // One section.
  buf.writeUInt16LE(0xf0, 0x94);
  const optional = 0x98;
  buf.writeUInt16LE(0x20b, optional);
  buf.writeBigUInt64LE(0x140000000n, optional + 24);
  buf.writeUInt32LE(16, optional + 108); // NumberOfRvaAndSizes.
  const directories = optional + 112;
  buf.writeUInt32LE(0x1100, directories + 8); // Normal import table.
  buf.writeUInt32LE(0x180, directories + 12);
  if (delayedDlls.length) {
    buf.writeUInt32LE(0x1300, directories + 13 * 8);
    buf.writeUInt32LE(0x100, directories + 13 * 8 + 4);
  }
  const section = optional + 0xf0;
  buf.write(".rdata\0\0", section, "ascii");
  buf.writeUInt32LE(0x1000, section + 8);
  buf.writeUInt32LE(0x1000, section + 12);
  buf.writeUInt32LE(0x1000, section + 16);
  buf.writeUInt32LE(0x400, section + 20);
  const rva = (offset) => offset - 0x400 + 0x1000;
  for (const [index, dll] of normalDlls.entries()) {
    const descriptor = 0x500 + index * 20;
    const name = 0x900 + index * 64;
    buf.writeUInt32LE(rva(name), descriptor + 12);
    buf.write(dll + "\0", name, "ascii");
  }
  for (const [index, dll] of delayedDlls.entries()) {
    const descriptor = 0x700 + index * 32;
    const name = 0xb00 + index * 64;
    buf.writeUInt32LE(1, descriptor); // Delay import uses RVAs.
    buf.writeUInt32LE(rva(name), descriptor + 4);
    buf.write(dll + "\0", name, "ascii");
  }
  return buf;
}

test("portable Windows agent accepts kernel32 and Windows 10 built-in UCRT imports", () => {
  const result = inspectPeImports(samplePe(["KERNEL32.dll", "ucrtbase.dll"]));
  assert.deepEqual(result.dynamicVcRuntime, []);
  assert.deepEqual(result.importedDlls, ["kernel32.dll", "ucrtbase.dll"]);
});

test("the old v0.1.0 VCRUNTIME140 import is rejected without executing the binary", () => {
  assert.deepEqual(
    inspectPeImports(samplePe(["KERNEL32.dll", "VCRUNTIME140.dll"])).dynamicVcRuntime,
    ["vcruntime140.dll"],
  );
});

test("VCRUNTIME140_1, MSVCP140 and delay imports are rejected", () => {
  const result = inspectPeImports(samplePe(
    ["KERNEL32.dll", "MSVCP140.dll"],
    ["VCRUNTIME140_1.dll"],
  ));
  assert.deepEqual(result.dynamicVcRuntime, ["msvcp140.dll", "vcruntime140_1.dll"]);
});

test("other VC++ runtime variants and incorrect CPU architecture are denied", () => {
  const result = inspectPeImports(samplePe([
    "MSVCP140_ATOMIC_WAIT.dll", "VCRUNTIME140_APP.dll", "MFC140.dll",
  ]));
  assert.deepEqual(result.dynamicVcRuntime, [
    "mfc140.dll", "msvcp140_atomic_wait.dll", "vcruntime140_app.dll",
  ]);
  const wrongMachine = samplePe(["KERNEL32.dll"]);
  wrongMachine.writeUInt16LE(0x14c, 0x84);
  assert.throws(() => inspectPeImports(wrongMachine), /UNEXPECTED_ARCHITECTURE/);
});

test("malformed PE and mapped-import corruption fail closed", () => {
  assert.throws(() => inspectPeImports(Buffer.from("not PE")), /NOT_PE/);
  const broken = samplePe(["kernel32.dll"]);
  broken.writeUInt32LE(0x9fffffff, 0x500 + 12);
  assert.throws(() => inspectPeImports(broken), /UNMAPPED_RVA/);
});

test("CLI denies a dynamic MSVC dependency and passes an isolated portable fixture", () => {
  const directory = mkdtempSync(join(tmpdir(), "tp-runtime-imports-"));
  try {
    const file = join(directory, "tetherd.exe");
    writeFileSync(file, samplePe(["KERNEL32.dll", "VCRUNTIME140.dll"]));
    const fail = spawnSync(process.execPath, [auditPath, file], { encoding: "utf8" });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /WINDOWS_DYNAMIC_VC_RUNTIME_DEPENDENCY/);
    writeFileSync(file, samplePe(["KERNEL32.dll"]));
    const ok = spawnSync(process.execPath, [auditPath, file], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /"portableRuntimeCheck":"PASS"/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("candidate packaging and Windows CI must enforce static CRT and inspect built imports", () => {
  const packager = read("scripts/package-windows.ps1");
  const ci = read(".github/workflows/ci.yml");
  assert.match(packager, /-C target-feature=\+crt-static/);
  assert.match(packager, /check-pe-runtime-imports\.mjs/);
  const installedSmoke = read("tests/release/windows-package-smoke.ps1");
  assert.match(installedSmoke, /check-pe-runtime-imports\.mjs/);
  assert.match(installedSmoke, /installed Windows agent requires a nonportable VC\+\+ runtime/);
  assert.match(ci, /RUSTFLAGS: "-C target-feature=\+crt-static"/);
  assert.match(ci, /node scripts\/windows\/check-pe-runtime-imports\.mjs target\/release\/tetherd\.exe/);
});

test("toast CI must inspect both native executables before test-artifact packaging", () => {
  const ci = read(".github/workflows/windows-toast-developer-beta.yml");
  assert.match(ci, /RUSTFLAGS: "-C target-feature=\+crt-static"/);
  assert.match(ci, /node scripts\/windows\/check-pe-runtime-imports\.mjs target\/release\/tetherplane-toast-smoke\.exe/);
  assert.match(ci, /node scripts\/windows\/check-pe-runtime-imports\.mjs target\/release\/tetherd\.exe/);
});
