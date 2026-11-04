// Inspect normal and delay-loaded PE imports without executing the binary.
// Used to reject Windows release candidates that depend on separately installed
// Visual C++ runtime DLLs. Passing does not replace clean-install acceptance.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const VC_RUNTIME = /^(?:vcruntime\d+|msvcp\d+|concrt\d+|vccorlib\d+|mfc(?:m)?\d+)(?:_[a-z0-9]+)*\.dll$/i;

export function inspectPeImports(bytes) {
  const data = Buffer.from(bytes);
  function bounds(at, count = 1) {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(count) ||
        at < 0 || count < 0 || at + count > data.length) {
      throw new Error("PE_IMPORT_AUDIT_INVALID_BOUNDS");
    }
  }
  const u16 = (i) => (bounds(i, 2), data.readUInt16LE(i));
  const u32 = (i) => (bounds(i, 4), data.readUInt32LE(i));
  function cstr(at) {
    bounds(at);
    const end = data.indexOf(0, at);
    if (end < 0 || end - at > 260) throw new Error("PE_IMPORT_AUDIT_BAD_DLL_NAME");
    const name = data.toString("ascii", at, end);
    if (!/^[A-Za-z0-9._-]+\.dll$/i.test(name)) {
      throw new Error("PE_IMPORT_AUDIT_INVALID_DLL_NAME");
    }
    return name;
  }

  if (data.length < 512 || data.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("PE_IMPORT_AUDIT_NOT_PE");
  }
  const pe = u32(0x3c);
  bounds(pe, 24);
  if (data.toString("hex", pe, pe + 4) !== "50450000") {
    throw new Error("PE_IMPORT_AUDIT_BAD_SIGNATURE");
  }
  if (u16(pe + 4) !== 0x8664) {
    throw new Error("PE_IMPORT_AUDIT_UNEXPECTED_ARCHITECTURE");
  }
  const sectionsCount = u16(pe + 6);
  const optionalSize = u16(pe + 20);
  const optional = pe + 24;
  bounds(optional, optionalSize);
  const magic = u16(optional);
  if (magic !== 0x20b && magic !== 0x10b) {
    throw new Error("PE_IMPORT_AUDIT_UNSUPPORTED_OPTIONAL_HEADER");
  }
  const directoriesOffset = optional + (magic === 0x20b ? 112 : 96);
  const directoryCountOffset = optional + (magic === 0x20b ? 108 : 92);
  if (optionalSize < (magic === 0x20b ? 128 : 112)) {
    throw new Error("PE_IMPORT_AUDIT_TRUNCATED_HEADER");
  }
  const directoryCount = u32(directoryCountOffset);
  if (sectionsCount === 0 || sectionsCount > 96 || directoryCount < 2) {
    throw new Error("PE_IMPORT_AUDIT_INCOMPLETE_TABLE");
  }
  const sectionsOffset = optional + optionalSize;
  bounds(sectionsOffset, sectionsCount * 40);
  const sections = Array.from({ length: sectionsCount }, (_, i) => {
    const at = sectionsOffset + i * 40;
    return {
      virtualSize: u32(at + 8),
      rva: u32(at + 12),
      rawSize: u32(at + 16),
      rawOffset: u32(at + 20),
    };
  });
  function rvaOffset(rva) {
    const section = sections.find((s) =>
      rva >= s.rva && rva - s.rva < Math.max(s.virtualSize, s.rawSize));
    if (!section) throw new Error("PE_IMPORT_AUDIT_UNMAPPED_RVA");
    const delta = rva - section.rva;
    if (delta >= section.rawSize) throw new Error("PE_IMPORT_AUDIT_UNBACKED_RVA");
    const offset = section.rawOffset + delta;
    bounds(offset);
    return offset;
  }
  function directory(index) {
    if (index >= directoryCount) return { rva: 0, size: 0 };
    const at = directoriesOffset + index * 8;
    if (at + 8 > optional + optionalSize) {
      throw new Error("PE_IMPORT_AUDIT_TRUNCATED_DIRECTORY");
    }
    return { rva: u32(at), size: u32(at + 4) };
  }
  const imports = [];
  const normal = directory(1);
  if (!normal.rva) throw new Error("PE_IMPORT_AUDIT_MISSING_IMPORT_DIRECTORY");
  let ended = false;
  for (let index = 0; index < 1024; index += 1) {
    const at = rvaOffset(normal.rva + index * 20);
    bounds(at, 20);
    const descriptor = [0, 4, 8, 12, 16].map((x) => u32(at + x));
    if (descriptor.every((n) => n === 0)) {
      ended = true;
      break;
    }
    imports.push(cstr(rvaOffset(descriptor[3])));
  }
  if (!ended) throw new Error("PE_IMPORT_AUDIT_UNTERMINATED_IMPORTS");

  const delayed = directory(13);
  if (delayed.rva) {
    ended = false;
    const imageBase = magic === 0x20b
      ? (bounds(optional + 24, 8), data.readBigUInt64LE(optional + 24))
      : BigInt(u32(optional + 28));
    for (let index = 0; index < 1024; index += 1) {
      const at = rvaOffset(delayed.rva + index * 32);
      bounds(at, 32);
      const descriptor = Array.from({ length: 8 }, (_, i) => u32(at + i * 4));
      if (descriptor.every((n) => n === 0)) {
        ended = true;
        break;
      }
      const attributes = descriptor[0];
      const pointer = BigInt(descriptor[1]);
      const nameRva = attributes & 1 ? pointer : pointer - imageBase;
      if (nameRva < 0n || nameRva > 0xffffffffn) {
        throw new Error("PE_IMPORT_AUDIT_BAD_DELAY_IMPORT_ADDRESS");
      }
      imports.push(cstr(rvaOffset(Number(nameRva))));
    }
    if (!ended) throw new Error("PE_IMPORT_AUDIT_UNTERMINATED_DELAY_IMPORTS");
  }
  const importedDlls = [...new Set(imports.map((s) => s.toLowerCase()))].sort();
  const dynamicVcRuntime = importedDlls.filter((s) => VC_RUNTIME.test(s));
  return { importedDlls, dynamicVcRuntime };
}

export function checkPeRuntime(path) {
  const { importedDlls, dynamicVcRuntime } = inspectPeImports(readFileSync(path));
  return {
    file: basename(path),
    importCount: importedDlls.length,
    dynamicVcRuntime,
    portableRuntimeCheck: dynamicVcRuntime.length === 0 ? "PASS" : "FAIL",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Usage: node check-pe-runtime-imports.mjs PATH_TO_WINDOWS_EXE");
    }
    const result = checkPeRuntime(process.argv[2]);
    process.stdout.write("PE_RUNTIME_IMPORT_AUDIT=" + JSON.stringify(result) + "\n");
    if (result.dynamicVcRuntime.length > 0) {
      process.stderr.write(
        "WINDOWS_DYNAMIC_VC_RUNTIME_DEPENDENCY: " +
        result.dynamicVcRuntime.join(",") + "\n",
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write("PE_IMPORT_AUDIT_FAILED: " + error.message + "\n");
    process.exitCode = 2;
  }
}
