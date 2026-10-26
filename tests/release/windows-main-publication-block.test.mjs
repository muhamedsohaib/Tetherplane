import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const release = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const ci = readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function assertUnsignedReleaseDisabled(source) {
  assert.match(source, /^on:\n  push:\n    tags:\n      - "v\*"\s*$/m);
  assert.match(source, /^permissions:\n  contents: read\s*$/m);
  assert.doesNotMatch(source, /^\s*contents: write\s*$/m);

  const jobs = source.split(/^jobs:\s*$/m);
  assert.equal(jobs.length, 2, "one jobs section required");
  const jobNames = [...jobs[1].matchAll(/^  ([a-z][\w-]*):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(jobNames, ["windows-x64"], "no alternative publication job");

  const job = jobs[1];
  assert.match(job, /^    runs-on: windows-latest\s*$/m);
  const stepsMarker = "    steps:\n";
  assert.equal(job.split(stepsMarker).length, 2, "one steps section required");
  const steps = job.split(stepsMarker)[1];
  const stepHeaders = [...steps.matchAll(/^      - /gm)];
  assert.equal(stepHeaders.length, 1, "only the release-denial step may execute");

  assert.match(steps, /^      - name: Block unsigned Windows public release\s*$/m);
  assert.match(steps, /^        shell: pwsh\s*$/m);
  assert.doesNotMatch(steps, /^        (?:if|continue-on-error|uses|with|env):/m);
  const run = steps.split(/^        run: \|\s*$/m);
  assert.equal(run.length, 2, "one mandatory fail-closed command block");
  const commands = run[1].split("\n").map((line) => line.trim()).filter(Boolean);
  assert.equal(commands.length, 1, "no command may execute after the release denial");
  assert.match(commands[0], /^throw 'UNSIGNED_PUBLIC_RELEASE_BLOCKED: [^']+'$/);

  assert.doesNotMatch(source, /gh release create|actions\/upload-artifact|package-windows\.ps1|Compress-Archive/,
    "legacy unsigned build and publishing must not be reachable");
}

test("main tag workflow cannot build or publish an unsigned Windows package", () => {
  assertUnsignedReleaseDisabled(release);
});

test("push and pull-request CI must execute the publication guard", () => {
  assert.match(ci, /^on:\n  push:\s*\n  pull_request:\s*$/m);
  const expected = [
    "      - name: Enforce fail-closed public release policy",
    "        run: node --test tests/release/windows-main-publication-block.test.mjs",
  ].join("\n");
  assert.ok(ci.includes(expected), "publication guard is required in CI");
  const start = ci.indexOf("      - name: Enforce fail-closed public release policy");
  const next = ci.indexOf("\n      - ", start + 1);
  const step = ci.slice(start, next === -1 ? undefined : next);
  assert.doesNotMatch(step, /^        (?:if|continue-on-error):/m, "CI must not skip or ignore release guard");
});

test("source contract rejects valid-YAML skip and ignored-failure mutations", () => {
  // These are sibling step keys, not text appended inside a PowerShell run block.
  const changes = [
    (s) => s.replace("contents: read", "contents: write"),
    (s) => s.replace("throw 'UNSIGNED_PUBLIC_RELEASE_BLOCKED:", "Write-Output 'UNSIGNED_PUBLIC_RELEASE_BLOCKED:"),
    (s) => s.replace("        shell: pwsh", "        if: false\n        shell: pwsh"),
    (s) => s.replace("        shell: pwsh", "        continue-on-error: true\n        shell: pwsh"),
    (s) => s.replace("    steps:\n", "    steps:\n      - name: Publish first\n        run: echo unsafe\n"),
    (s) => s.replace("  windows-x64:\n", "  extra-publisher:\n    runs-on: windows-latest\n    steps:\n      - run: echo unsafe\n  windows-x64:\n"),
    (s) => s.replace("          throw 'UNSIGNED_PUBLIC_RELEASE_BLOCKED:", "          echo 'UNSIGNED_PUBLIC_RELEASE_BLOCKED:"),
    (s) => s.replace(/(^\s*throw 'UNSIGNED_PUBLIC_RELEASE_BLOCKED:[^\n]*$)/m, "$1\n          echo bypass"),
    (s) => s + "\n      - name: Publish\n        run: gh release create v1 untrusted.zip\n",
  ];
  for (const weaken of changes) {
    const mutant = weaken(release);
    assert.notEqual(mutant, release, "mutation must edit source");
    assert.throws(() => assertUnsignedReleaseDisabled(mutant),
      "weakened release contract must be rejected");
  }
});
