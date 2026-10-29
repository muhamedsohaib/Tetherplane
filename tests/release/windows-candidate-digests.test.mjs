import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("../../scripts/release/windows-candidate-digests.mjs", import.meta.url));
const source = "9a7ceaf2be07af2423005a136bb2cb30fcdfbbb0";
const otherSource = "bd1ef7845e61077c942c884aca82cc00d26b0e99";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tetherplane-digest-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packagePath = join(root, "package");
  mkdirSync(join(packagePath, "bin"), { recursive: true });
  writeFileSync(join(packagePath, "manifest.json"), JSON.stringify({ source_commit: source, platform: "windows", architecture: "x64" }));
  // Inert bytes: these tests never launch a binary or claim valid PE/signature evidence.
  writeFileSync(join(packagePath, "bin", "tetherd.exe"), "abc");
  writeFileSync(join(packagePath, "bin", "tetherd-agentw.exe"), "");
  return { root, packagePath, recordPath: join(root, "inventory.json") };
}

function invoke(...args) {
  return spawnSync(process.execPath, [command, ...args], { encoding: "utf8", timeout: 15000 });
}

function record(f) {
  const result = invoke("record", f.packagePath, source);
  assert.equal(result.status, 0, `candidate digest recording must succeed: ${result.stderr}`);
  writeFileSync(f.recordPath, result.stdout);
  return { bytes: result.stdout, value: JSON.parse(result.stdout) };
}

function verify(f, bytes, expectedSource = source, expectedDigest = digest(bytes)) {
  return invoke("verify", f.packagePath, expectedSource, f.recordPath, expectedDigest);
}

test("records stable SHA-256 evidence without executing or changing payloads", (t) => {
  const f = fixture(t);
  const first = record(f);
  assert.equal(record(f).bytes, first.bytes);
  assert.equal(first.value.source_commit, source);
  assert.deepEqual(first.value.files.map((file) => file.path), ["bin/tetherd-agentw.exe", "bin/tetherd.exe", "manifest.json"]);
  assert.deepEqual(first.value.files.slice(0, 2), [
    { path: "bin/tetherd-agentw.exe", size: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    { path: "bin/tetherd.exe", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
  ]);
  assert.equal(readFileSync(join(f.packagePath, "bin", "tetherd.exe"), "utf8"), "abc");
  assert.equal(existsSync(join(f.packagePath, "inventory.json")), false);
});

test("matching bytes never become publisher, signature or Windows acceptance evidence", (t) => {
  const f = fixture(t);
  const { bytes } = record(f);
  const result = verify(f, bytes);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    byte_identity: "MATCH", source_commit: source,
    build_provenance: "UNVERIFIED", authenticode: "UNVERIFIED",
    windows_acceptance: "NOT_RUN", release: "NO_GO",
  });
});

for (const mutation of ["changed", "removed", "extra"]) {
  test(`verification rejects ${mutation} payload bytes`, (t) => {
    const f = fixture(t);
    const { bytes } = record(f);
    if (mutation === "changed") writeFileSync(join(f.packagePath, "bin", "tetherd.exe"), "abd");
    if (mutation === "removed") rmSync(join(f.packagePath, "bin", "tetherd-agentw.exe"));
    if (mutation === "extra") writeFileSync(join(f.packagePath, "extra.ps1"), "unexpected");
    const result = verify(f, bytes);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CANDIDATE_EVIDENCE_REJECTED/);
    assert.equal(result.stdout, "");
  });
}

test("verification rejects a tampered inventory before trusting its claims", (t) => {
  const f = fixture(t);
  const { bytes, value } = record(f);
  value.source_commit = otherSource;
  writeFileSync(f.recordPath, JSON.stringify(value));
  const result = verify(f, bytes);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inventory digest mismatch/);
});

test("verification requires an independent expected digest even if all files match", (t) => {
  const f = fixture(t);
  const { bytes } = record(f);
  const result = verify(f, bytes, source, "0".repeat(64));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inventory digest mismatch/);
  assert.notEqual(invoke("verify", f.packagePath, source, f.recordPath).status, 0);
});

test("expected source must match the package manifest and inventory", (t) => {
  const f = fixture(t);
  const { bytes } = record(f);
  assert.notEqual(verify(f, bytes, otherSource).status, 0);
  assert.notEqual(invoke("record", f.packagePath, "main").status, 0);
  writeFileSync(join(f.packagePath, "manifest.json"), JSON.stringify({ source_commit: otherSource }));
  assert.notEqual(invoke("record", f.packagePath, source).status, 0);
});

test("required binary payloads and manifest cannot be omitted", (t) => {
  const f = fixture(t);
  rmSync(join(f.packagePath, "bin", "tetherd-agentw.exe"));
  const result = invoke("record", f.packagePath, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required payload/);
});

test("an authenticated inventory cannot smuggle an unsupported schema or positive release claim", (t) => {
  const f = fixture(t);
  const { value } = record(f);
  value.release = "GO";
  const bytes = JSON.stringify(value);
  writeFileSync(f.recordPath, bytes);
  const result = verify(f, bytes);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inventory contents mismatch/);
});

test("linked directories cannot escape the candidate root", (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "external.txt"), "not a candidate payload");
  symlinkSync(outside, join(f.packagePath, "linked"), process.platform === "win32" ? "junction" : "dir");
  const result = invoke("record", f.packagePath, source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /linked path/);
});

test("case-distinct Windows path aliases are rejected on a case-sensitive filesystem", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  mkdirSync(join(f.packagePath, "BIN"), { recursive: true });
  writeFileSync(join(f.packagePath, "BIN", "other.dll"), "bytes");
  assert.notEqual(invoke("record", f.packagePath, source).status, 0);
});

for (const name of ["COM\u00b9.txt", "LPT\u00b2.txt", "COM\u00b3.txt"]) {
  test(`Windows superscript device name ${name} is rejected`, (t) => {
    const f = fixture(t);
    // Namespaced Windows paths let this inert fixture create reserved names.
    writeFileSync(toNamespacedPath(join(f.packagePath, name)), "inert bytes");
    const result = invoke("record", f.packagePath, source);
    assert.notEqual(result.status, 0, "reserved Windows device alias must be rejected");
    assert.match(result.stderr, /unsupported Windows payload name/);
  });
}
