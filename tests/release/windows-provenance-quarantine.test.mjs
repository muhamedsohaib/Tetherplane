import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const workflow = readFileSync(new URL("../../.github/workflows/windows-candidate-provenance.yml", import.meta.url), "utf8");

function check(w) {
  assert.match(w, /^on:\n  push:\n    branches:\n      - test\/windows-provenance-quarantine-20261030$/m);
  assert.doesNotMatch(w, /^  (?:pull_request|workflow_dispatch|workflow_run|release|schedule):/m);
  assert.doesNotMatch(w, /gh release create|softprops\/action-gh-release|contents: write|deploy-pages/);
  assert.match(w, /^permissions:\n  contents: read/m);
  assert.match(w, /runs-on: windows-latest/);
  assert.match(w, /runs-on: ubuntu-latest/);
  assert.match(w, /id-token: write\n      attestations: write\n      artifact-metadata: write/);
  assert.match(w, /actions\/attest@[a-f0-9]{40}/);
  assert.match(w, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(w, /actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(w, /retention-days: 1/);
  assert.match(w, /UNSIGNED-DO-NOT-INSTALL/);
  assert.match(w, /--signer-workflow/);
  assert.match(w, /--source-ref "\$GITHUB_REF"/);
  assert.match(w, /--source-digest "\$GITHUB_SHA"/);
  assert.match(w, /--deny-self-hosted-runners/);
  const verify = w.split(/^  independent-verify:\n/m)[1];
  assert.ok(verify);
  assert.match(verify, /permissions:\n      contents: read\n      attestations: read/);
  assert.doesNotMatch(verify, /id-token: write|attestations: write|contents: write/);
}
test("isolate unsigned attestation to authorized test branch", () => check(workflow));
test("reject expanded triggers, release capability and excess retention", () => {
  const mutations = [
    w => w.replace("      - test/windows-provenance-quarantine-20261030", "      - main"),
    w => w.replace("on:\n  push:", "on:\n  pull_request:\n  push:"),
    w => w.replace("retention-days: 1", "retention-days: 90"),
    w => w.replace("attestations: read", "attestations: write"),
    w => w.replace('--source-digest "$GITHUB_SHA"', '--source-digest "$NOT_SHA"'),
    w => w.replace("actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6", "actions/attest@v4"),
  ];
  for (const mutate of mutations) assert.throws(() => check(mutate(workflow)));
});
