// Byte evidence only: never execute, install, sign or promote candidate content.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const claims = {
  build_provenance: "UNVERIFIED", authenticode: "UNVERIFIED",
  windows_acceptance: "NOT_RUN", release: "NO_GO",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const render = (value) => JSON.stringify(value, null, 2) + "\n";
const reject = (reason) => { throw new Error(reason); };

function hashFile(path) {
  const descriptor = openSync(path, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) reject("unsupported or hard-linked payload");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) !== 0) {
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      reject("payload changed while hashing");
    }
    return { size: before.size, sha256: hash.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

function inventory(packagePath, source) {
  if (!/^[0-9a-f]{40}$/.test(source)) reject("expected source must be a full lowercase commit SHA");
  const root = resolve(packagePath);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink()) reject("linked path at package root");
  if (!rootStat.isDirectory()) reject("package root must be a directory");
  const files = [];
  const names = new Set();
  function visit(directory, parent = "") {
    for (const name of readdirSync(directory).sort()) {
      if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[ .]$/.test(name) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) {
        reject("unsupported Windows payload name");
      }
      const relative = parent + name;
      const key = relative.toLowerCase();
      if (names.has(key)) reject("case-folded Windows path collision");
      names.add(key);
      const absolute = join(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) reject("linked path in package");
      if (stat.isDirectory()) visit(absolute, relative + "/");
      else if (stat.isFile()) files.push({ path: relative, ...hashFile(absolute) });
      else reject("unsupported payload file type");
    }
  }
  visit(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const required of ["manifest.json", "bin/tetherd.exe", "bin/tetherd-agentw.exe"]) {
    if (!files.some((file) => file.path === required)) reject("required payload missing: " + required);
  }
  const manifestBytes = readFileSync(join(root, "manifest.json"));
  if (sha256(manifestBytes) !== files.find((file) => file.path === "manifest.json").sha256) {
    reject("manifest changed while recording");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.source_commit !== source) reject("package manifest source mismatch");
  if (manifest.platform !== "windows" || manifest.architecture !== "x64") reject("expected Windows x64 manifest");
  return { schema: "tetherplane.windows-candidate-digests.v1", source_commit: source, files, ...claims };
}

try {
  const [operation, packagePath, source, recordPath, expectedDigest, ...extra] = process.argv.slice(2);
  if (!packagePath || !source || extra.length ||
      (operation === "record" && (recordPath || expectedDigest)) ||
      (operation !== "record" && operation !== "verify")) {
    reject("usage: record PACKAGE SOURCE | verify PACKAGE SOURCE INVENTORY EXPECTED_INVENTORY_SHA256");
  }
  if (operation === "record") {
    process.stdout.write(render(inventory(packagePath, source)));
  } else {
    if (!recordPath || !/^[0-9a-f]{64}$/.test(expectedDigest ?? "")) reject("independent expected inventory SHA-256 required");
    const recordBytes = readFileSync(recordPath);
    if (sha256(recordBytes) !== expectedDigest) reject("inventory digest mismatch");
    const actual = inventory(packagePath, source);
    // Canonical bytes avoid duplicate JSON keys, unsupported claims or path interpretation.
    if (!recordBytes.equals(Buffer.from(render(actual), "utf8"))) reject("inventory contents mismatch");
    process.stdout.write(render({ byte_identity: "MATCH", source_commit: source, ...claims }));
  }
} catch (error) {
  process.stderr.write("CANDIDATE_EVIDENCE_REJECTED: " + error.message + "\n");
  process.exitCode = 1;
}
