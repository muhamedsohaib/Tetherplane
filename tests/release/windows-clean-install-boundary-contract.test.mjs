import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const get = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const workflow = get("../../.github/workflows/windows-clean-install-boundary.yml");
const script = get("./windows-clean-install-boundary.ps1");

function verifyWorkflow(content) {
  assert.match(content, /^on:\n  pull_request:/m);
  assert.doesNotMatch(content, /^  (?:push|release|workflow_dispatch):/m);
  assert.match(content, /^permissions:\n  contents: read$/m);
  assert.match(content, /runs-on: windows-latest/);
  assert.match(content, /timeout-minutes: 15/);
  assert.match(content, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(content, /startsWith\(github\.head_ref, 'test\/windows-clean-install-boundary-'\)/);
  assert.match(content, /node --test tests\/release\/windows-clean-install-boundary-contract\.test\.mjs/);
  assert.match(content, /windows-clean-install-boundary\.ps1/);
  assert.match(content, /path: \$\{\{ runner\.temp \}\}\/tetherplane-clean-install-boundary-report\.json/);
  assert.doesNotMatch(content, /contents: write|permissions:\s*write-all|secrets\.|gh release create|store publish/i);
  assert.doesNotMatch(content, /upload-artifact[^\n]*\.exe|upload-artifact[^\n]*\.msix/i);
}

function verifyScript(content) {
  assert.match(content, /GITHUB_ACTIONS -cne 'true'/);
  assert.match(content, /GITHUB_EVENT_NAME -cne 'pull_request'/);
  assert.match(content, /RUNNER_ENVIRONMENT -cne 'github-hosted'/);
  assert.match(content, /RUNNER_OS -cne 'Windows'/);
  assert.match(content, /GITHUB_HEAD_REF\.StartsWith\('test\/windows-clean-install-boundary-'\)/);
  assert.match(content, /Join-Path \$runnerTemp/);
  assert.match(content, /ParseFile\(/);
  assert.match(content, /\$ast\.ParamBlock/);
  assert.match(content, /SYNTHETIC_NOT_EXECUTABLE/);
  assert.match(content, /MUST_SURVIVE_INVALID_PRECONDITION/);
  assert.match(content, /invalid_scheduled_args_rejected/);
  assert.match(content, /force_preserves_previous_install/);
  assert.match(content, /no_scheduled_task_registered/);
  assert.match(content, /\$target\.StartsWith\(\$prefix/);
  assert.match(content, /isolated_scratch_cleanup/);
  assert.doesNotMatch(content, /Start-Process|Invoke-WebRequest|Invoke-RestMethod|Register-ScheduledTask\s|Unregister-ScheduledTask\s|Import-Certificate\s|New-SelfSignedCertificate\s|Export-PfxCertificate\s/);
}

test("CI workflow is PR-only, same-repo, hosted Windows, read-only token", () => {
  verifyWorkflow(workflow);
});

test("boundary test refuses production devices and limits deletion to synthetic scratch", () => {
  verifyScript(script);
});

test("negative controls reject loosening PR gate and scratch protection", () => {
  for (const bad of [
    workflow.replace("contents: read", "contents: write"),
    workflow.replace("github.event.pull_request.head.repo.full_name == github.repository", "true"),
    workflow.replace("on:\n  pull_request:", "on:\n  push:\n  pull_request:"),
  ]) assert.throws(() => verifyWorkflow(bad));

  for (const bad of [
    script.replace("RUNNER_ENVIRONMENT -cne 'github-hosted'", "RUNNER_ENVIRONMENT -cne 'local'"),
    script.replace("$target.StartsWith($prefix", "$target.EndsWith($prefix"),
    script.replaceAll("MUST_SURVIVE_INVALID_PRECONDITION", "NO_PRESERVATION_CHECK"),
    script.replace("$ast.ParamBlock", "$ast.EndBlock"),
  ]) assert.throws(() => verifyScript(bad));
});
