import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relative) {
  return readFileSync(new URL("../../" + relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const installer = read("scripts/install-windows.ps1");
const launcher = read("packaging/windows/tetherplane-mcp.ps1");
const probe = read("tests/release/windows-clean-install-preflight.ps1");
const workflow = read(".github/workflows/ci.yml");
const packageSmoke = read("tests/release/windows-package-smoke.ps1");
const launcherHandshake = read("tests/release/windows-launcher-handshake.mjs");
const launcherEnvRegression = read("adapters/compact-mcp/windows-powershell-launcher-env.test.mjs");

function assertSafeInstaller(source) {
  assert.match(source, /install prefix and state directory must not overlap/);
  assert.match(source, /AgentArgumentsFile must contain valid JSON/);
  assert.match(source, /refusing to replace a populated install prefix, including with -Force/);
  assert.match(source, /existing Tetherplane Agent task requires separately reviewed migration/);
  assert.doesNotMatch(source, /Remove-Item\s+-LiteralPath\s+\$install\b/i);
  assert.doesNotMatch(source, /Unregister-ScheduledTask/);
  assert.doesNotMatch(source, /Register-ScheduledTask[^\n]*\s-Force\b/);
  const preflight = source.indexOf("install prefix and state directory must not overlap");
  const argsCheck = source.indexOf("AgentArgumentsFile must contain valid JSON");
  const copying = source.indexOf("Copy-Item -LiteralPath");
  assert.ok(preflight > 0 && argsCheck > 0 && copying > preflight && copying > argsCheck);
}

function assertSafeWorkflow(source) {
  assert.match(source, /name: Windows cold installer preflight \(synthetic fixture; nonrelease\)/);
  assert.match(source, /run: .*windows-clean-install-preflight\.ps1/);
  assert.match(source, /github\.event_name == 'pull_request'/);
  assert.equal((source.match(/github\.event\.pull_request\.head\.repo\.full_name == github\.repository/g) || []).length, 2, "Both execution and artifact upload require a same-repository pull request");
  assert.match(source, /tetherplane-clean-install-report\.json/);
  assert.match(source, /Windows packaged PowerShell stdio regression \(synthetic fixture\)/);
  assert.match(source, /node --test adapters\/compact-mcp\/windows-powershell-launcher-env\.test\.mjs/);
  assert.doesNotMatch(source, /contents: write|gh release create|Store publish|New-SelfSignedCertificate/);
}

test("Compact MCP launcher declares parameters before executing statements", () => {
  assert.match(launcher, /^param\(\n\s+\[Parameter\(ValueFromRemainingArguments = \$true\)\]/);
});

test("PowerShell MCP launcher uses full-duplex native execution under filtered SDK environment", () => {
  assert.match(launcher, /New-Object System.Diagnostics.ProcessStartInfo/);
  assert.match(launcher, /\$startInfo.UseShellExecute = \$false/);
  assert.match(launcher, /RedirectStandardInput = \$true/);
  assert.match(launcher, /RedirectStandardOutput = \$true/);
  assert.match(launcher, /RedirectStandardError = \$true/);
  assert.match(launcher, /\[Console\]::OpenStandardInput\(\)/);
  assert.match(launcher, /\[Console\]::OpenStandardOutput\(\)/);
  assert.match(launcher, /CopyToAsync\(/);
  assert.match(launcher, /Quote-NativeArgument/);
  assert.match(launcherEnvRegression, /historical launcher fails under the restricted MCP SDK environment/);
  assert.match(launcherEnvRegression, /actual installed PowerShell launcher transports six MCP tools/);
});

test("installer rejects destructive replacement and validates before copying", () => {
  assertSafeInstaller(installer);
});

test("cold-install probe runs only in disposable pull-request Windows CI", () => {
  assert.match(probe, /RUNNER_ENVIRONMENT -cne 'github-hosted'/);
  assert.match(probe, /GITHUB_EVENT_NAME -cne 'pull_request'/);
  assert.match(probe, /synthetic_fixture_only = \$true/);
  assert.match(probe, /installed_real_agent = \$false/);
  assert.match(probe, /Assert-Sentinel/);
  assert.match(probe, /malformed_args_leave_no_partial_install/);
  assert.match(probe, /no_scheduled_task_registered/);
  assert.match(probe, /tetherplane-cold-preflight-/);
  assert.doesNotMatch(probe, /Start-ScheduledTask|New-ScheduledTaskAction|Set-ItemProperty|Export-PfxCertificate|Invoke-WebRequest/i);
  assertSafeWorkflow(workflow);
});

test("packaged PowerShell entrypoint completes a real local MCP handshake in Windows CI", () => {
  assert.match(packageSmoke, /windows-launcher-handshake\.mjs/);
  assert.match(packageSmoke, /packaged PowerShell MCP launcher handshake failed/);
  assert.match(packageSmoke, /& node \$launcherSmoke --launcher/);
  assert.match(launcherHandshake, /new StdioClientTransport\(/);
  assert.match(launcherHandshake, /command: "powershell\.exe"/);
  assert.match(launcherHandshake, /await bounded\(client\.connect\(transport\), 20000\)/);
  assert.match(launcherHandshake, /await bounded\(client\.listTools\(\), 15000\)/);
  assert.match(launcherHandshake, /WINDOWS_PACKAGED_POWERSHELL_MCP_HANDSHAKE_PASS/);
  assert.match(launcherHandshake, /RUNNER_ENVIRONMENT !== "github-hosted"/);
  assert.doesNotMatch(launcherHandshake, /Invoke-WebRequest|New-SelfSignedCertificate|Register-ScheduledTask|gh release create/);
});

test("negative controls detect unsafe replacement, invalid launcher, and unrestricted CI", () => {
  assert.throws(() => assertSafeInstaller(installer.replace("refusing to replace a populated install prefix, including with -Force", "install prefix is not empty; use -Force")));
  assert.throws(() => assertSafeInstaller(installer + "\nRemove-Item -LiteralPath $install -Recurse -Force"));
  assert.throws(() => assertSafeInstaller(installer.replace("AgentArgumentsFile must contain valid JSON", "unchecked json")));
  assert.doesNotMatch("Set-StrictMode -Version Latest\n" + launcher, /^param\(/);
  assert.throws(() => assertSafeWorkflow(workflow.replace("github.event.pull_request.head.repo.full_name == github.repository", "true")));
});
