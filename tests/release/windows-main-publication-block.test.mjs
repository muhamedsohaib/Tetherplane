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

function assertIndependentPolicyCI(source) {
  assert.match(source, /^on:\n  push:\s*\n  pull_request:\s*$/m);
  const policy = source.split(/^  release-policy:\n/m)[1]?.split(/^  quality:\n/m)[0];
  assert.ok(policy, "dedicated release-policy job must be independent of quality");
  assert.match(policy, /^    runs-on: ubuntu-latest$/m);
  assert.match(policy, /^    permissions:\n      contents: read$/m);
  assert.doesNotMatch(policy, /^    (?:if|needs|continue-on-error|environment|env):/m,
    "release-policy job cannot be skipped, depend on quality, or ignore failure");
  assert.match(policy, /^      - uses: actions\/checkout@[0-9a-f]{40} /m);
  assert.match(policy, /^      - uses: actions\/setup-node@[0-9a-f]{40} /m);
  assert.match(policy, /^          persist-credentials: false$/m);
  assert.match(policy, /^          node-version: 22$/m);
  assert.match(policy, /^      - name: Enforce fail-closed public release policy\n        run: node --test tests\/release\/windows-main-publication-block\.test\.mjs$/m);
  assert.doesNotMatch(policy, /^        (?:if|continue-on-error|env):/m,
    "policy test step cannot be bypassed");
}

test("push and pull-request CI executes the independent release-policy job", () => {
  assertIndependentPolicyCI(ci);
});

test("CI policy isolation rejects skipped, dependent, and ignored-failure jobs", () => {
  const weakenings = [
    (s) => s.replace("  release-policy:\n", "  release-policy:\n    if: false\n"),
    (s) => s.replace("  release-policy:\n", "  release-policy:\n    needs: quality\n"),
    (s) => s.replace("  release-policy:\n", "  release-policy:\n    continue-on-error: true\n"),
    (s) => s.replace("      - name: Enforce fail-closed public release policy\n",
      "      - name: Enforce fail-closed public release policy\n        if: false\n"),
    (s) => s.replace("run: node --test tests/release/windows-main-publication-block.test.mjs",
      "run: echo skipped-source-check"),
    (s) => s.replace("      contents: read", "      contents: write"),
  ];
  for (const mutate of weakenings) {
    const weakened = mutate(ci);
    assert.notEqual(weakened, ci, "CI mutation must change source");
    assert.throws(() => assertIndependentPolicyCI(weakened),
      "independent policy check must reject weakened CI");
  }
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
