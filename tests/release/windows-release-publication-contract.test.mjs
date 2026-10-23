import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const releaseWorkflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

test("tag-triggered unsigned release has no publication token permission", () => {
  assert.match(releaseWorkflow, /^permissions:\s*\n  contents: read\s*$/m);
  assert.doesNotMatch(releaseWorkflow, /^\s*contents: write\s*$/m);
});

test("legacy unsigned workflow fails before any build or upload", () => {
  const marker = "UNSIGNED_PUBLIC_RELEASE_BLOCKED:";
  const markerIndex = releaseWorkflow.indexOf(marker);
  assert.ok(markerIndex >= 0, "explicit unconditional release block is mandatory");
  assert.match(
    releaseWorkflow,
    /- name: Block unsigned Windows public release\s*\n\s*shell: pwsh\s*\n\s*run: \|\s*\n\s*throw 'UNSIGNED_PUBLIC_RELEASE_BLOCKED:/,
  );
  for (const work of [
    "actions/checkout@",
    "Build Windows package",
    "Create archive and checksum",
    "actions/upload-artifact@",
    "gh release create",
  ]) {
    const index = releaseWorkflow.indexOf(work);
    assert.ok(index === -1 || markerIndex < index, `release block follows ${work}`);
  }
});

test("public release requires an explicit reviewed signing workflow replacement", () => {
  assert.match(releaseWorkflow, /^\s*tags:\s*\n\s*- "v\*"\s*$/m);
  assert.match(releaseWorkflow, /no approved signed candidate or independently verified promotion gate exists/);
});

console.log("WINDOWS_UNSIGNED_RELEASE_BLOCKED_CONTRACT_OK");
