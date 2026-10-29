import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../.github/workflows/windows-exact-candidate-cleanhost.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const runner = readFileSync(new URL("./windows-exact-candidate-cleanhost.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const source = "9c0cf237609c282c169537f89de25bc7fe697532";
const branch = "test/windows-exact-candidate-cleanhost-20261030";
const runId = "40962012801";

function assertContract(w) {
  assert.match(w, new RegExp("^on:\\n  push:\\n    branches:\\n      - " + branch + "$", "m"));
  assert.doesNotMatch(w, /^  (workflow_dispatch|pull_request|workflow_run|schedule|release):/m);
  assert.doesNotMatch(w, /contents: write|actions: write|attestations: write|id-token: write|artifact-metadata: write|gh release create|release\/upload|upload-artifact/);
  assert.match(w, /^permissions:\n  contents: read/m);
  assert.match(w, /permissions:\n      contents: read\n      actions: read\n      attestations: read/);
  assert.match(w, /runs-on: windows-latest/);
  assert.match(w, new RegExp("TP_EXACT_SOURCE: " + source));
  assert.match(w, new RegExp("TP_PROVENANCE_RUN: '" + runId + "'"));
  assert.match(w, /--source-digest \$env:TP_EXACT_SOURCE/);
  assert.match(w, /--source-ref \$env:TP_ORIGIN_REF/);
  assert.match(w, /--signer-workflow/);
  assert.match(w, /--deny-self-hosted-runners/);
  assert.match(w, /EXACT_CANDIDATE_AUTHENTICATED_BEFORE_INSTALL_OK/);
  assert.match(w, /windows-exact-candidate-cleanhost\.ps1/);
  const attestationIndex = w.indexOf("EXACT_CANDIDATE_AUTHENTICATED_BEFORE_INSTALL_OK");
  const installIndex = w.indexOf("windows-exact-candidate-cleanhost.ps1 -EvidenceDir");
  assert.ok(attestationIndex > 0 && installIndex > attestationIndex, "no install before attestation verification");
}
test("branch-only read-only permissions and pinned artifact identity", () => assertContract(workflow));
test("Windows CRLF checkout does not weaken contract", () => {
  assert.doesNotThrow(() => assertContract(workflow.replace(/\n/g, "\r\n").replace(/\r\n/g, "\n")));
});
test("deny broadening or weakening provenance gate", () => {
  const mutations = [
    (w) => w.replace("      - " + branch, "      - main"),
    (w) => w.replace("  push:\n", "  workflow_dispatch:\n  push:\n"),
    (w) => w.replace("      attestations: read", "      attestations: write"),
    (w) => w.replace("TP_EXACT_SOURCE: " + source, "TP_EXACT_SOURCE: " + "0".repeat(40)),
    (w) => w.replace("TP_PROVENANCE_RUN: '" + runId + "'", "TP_PROVENANCE_RUN: '1'"),
    (w) => w.replace("--source-digest $env:TP_EXACT_SOURCE", "--source-digest $env:OTHER"),
    (w) => w.replace("--deny-self-hosted-runners", "--allow-self-hosted-runners"),
    (w) => w.replace("EXACT_CANDIDATE_AUTHENTICATED_BEFORE_INSTALL_OK", "ATTESTATION_SKIPPED"),
  ];
  for (const mutate of mutations) {
    const weakened = mutate(workflow);
    assert.notEqual(weakened, workflow);
    assert.throws(() => assertContract(weakened));
  }
});
test("test runner never claims signing, upgrade rollback or real-device acceptance", () => {
  assert.match(runner, /UPGRADE_ROLLBACK_NOT_TESTED_NO_GO/);
  assert.match(runner, /Get-CimInstance Win32_Process/);
  assert.match(runner, /Get-ScheduledTask/);
  assert.match(runner, /CLEANHOST_MISSING_PAYLOAD_DENIED_BEFORE_WRITE_OK/);
  assert.match(runner, /CLEANHOST_FIRST_UNINSTALL_PRESERVED_STATE_OK/);
  assert.match(runner, /CLEANHOST_EXACT_ARCHIVE_REINSTALL_RECOVERY_OK/);
  assert.doesNotMatch(runner, /Register-ScheduledTask|Stop-ScheduledTask|New-ScheduledTaskAction|Set-ItemProperty|gh release create/);
});
