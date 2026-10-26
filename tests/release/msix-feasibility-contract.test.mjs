import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = readFileSync(new URL("../../packaging/msix-feasibility/AppxManifest.xml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const runner = readFileSync(new URL("../../scripts/msix/Test-TetherplaneMsixFeasibility.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const workflow = readFileSync(new URL("../../.github/workflows/msix-feasibility.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const bounded = readFileSync(new URL("../../scripts/msix/run-bounded-probe.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const preflight = readFileSync(new URL("../../scripts/msix/ci-prerequisites.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function assertSafeManifest(m) {
  assert.match(m, /Name="Tetherplane\.MsixFeasibility\.DevOnly"/);
  assert.match(m, /Publisher="CN=Tetherplane MSIX Development Probe"/);
  assert.match(m, /Executable="bin\\tetherd\.exe"/);
  assert.match(m, /uap10:RuntimeBehavior="packagedClassicApp"/);
  assert.match(m, /uap10:TrustLevel="mediumIL"/);
  assert.match(m, /<rescap:Capability Name="runFullTrust"/);
  assert.doesNotMatch(m, /startupTask|packagedServices|localSystemServices|broadFileSystemAccess|runFullTrust.*runFullTrust/is,
    "No startup, service or extra privileges in this first package-identity probe");
  assert.doesNotMatch(m, /Sohaib Labs|Publisher="CN=RealCompany"/i,
    "Test identity must not impersonate a real publisher");
}

function assertNonPublishingWorkflow(w) {
  assert.match(w, /^on:\n  pull_request:\n/m);
  assert.doesNotMatch(w, /^  (?:push|workflow_dispatch|release):/m);
  assert.match(w, /^permissions:\n  contents: read$/m);
  assert.match(w, /runs-on: windows-latest/);
  assert.match(w, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(w, /startsWith\(github\.head_ref, 'feature\/msix-feasibility-'\)/);
  assert.match(w, /node --test tests\/release\/msix-feasibility-contract\.test\.mjs tests\/release\/msix-powershell-env\.test\.mjs/);
  assert.match(w, /cargo build --release --locked -p tetherd/);
  assert.match(w, /run: node scripts\/msix\/run-bounded-probe\.mjs/);
  assert.match(w, /run: node scripts\/msix\/ci-prerequisites\.mjs/);
  assert.match(w, /timeout-minutes: 20/);
  assert.match(w, /path: \$\{\{ runner\.temp \}\}\/tetherplane-msix-probe-report\.json/);
  assert.doesNotMatch(w, /gh release create|vercel deploy|winget publish|store publish|signtool\.exe.*\/f|TETHERPLANE_SIGNING_READY|contents: write/i);
  assert.doesNotMatch(w, /(?:path|upload):\s*.*\.(?:exe|msix|pfx|cer)\b/i,
    "Do not upload any executable or signing material");
}

function assertEphemeralRunner(s) {
  assert.match(s, /GITHUB_ACTIONS -cne 'true'/);
  assert.match(s, /GITHUB_EVENT_NAME -cne 'pull_request'/);
  assert.match(s, /RUNNER_ENVIRONMENT -cne 'github-hosted'/);
  assert.match(s, /GITHUB_HEAD_REF\.StartsWith\('feature\/msix-feasibility-'\)/);
  assert.match(s, /Join-Path \$env:RUNNER_TEMP/);
  assert.match(s, /New-SelfSignedCertificate @certParams/);
  assert.match(s, /Import-Certificate -FilePath \$publicCertificateFile -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPeople'/);
  assert.match(s, /'Cert:\\LocalMachine\\TrustedPeople', 'Cert:\\CurrentUser\\My'/);
  assert.doesNotMatch(s, /Cert:\\(?:CurrentUser|LocalMachine)\\Root/,
    "A self-signed probe must never broaden root certificate trust");
  assert.match(s, /Get-AppxPackage/);
  assert.match(s, /Add-AppxPackage -Path \$packageFile/);
  assert.match(s, /Remove-AppxPackage -Package \$installedFullName/);
  assert.match(s, /certificate_cleanup/);
  assert.match(s, /function Save-MsixPhase/);
  assert.match(s, /Import-Module Microsoft\.PowerShell\.Security -ErrorAction Stop/);
  assert.match(s, /Get-PSDrive -Name Cert -ErrorAction SilentlyContinue/);
  assert.match(s, /function Get-Sha256Hex/);
  assert.match(s, /SHA256\]::Create\(\)/);
  assert.doesNotMatch(s, /Get-FileHash\b/, "Avoid module-dependent hashing in isolated CI PowerShell subprocess");
  assert.match(s, /Save-MsixPhase 'self_signed_cert_creation_started'/);
  assert.match(s, /Save-MsixPhase 'localmachine_trustedpeople_import_started'/);
  assert.match(s, /Save-MsixPhase 'add_appx_started'/);
  assert.match(s, /no_device_pairing = \$true/);
  assert.match(s, /agent_activated = \$false/);
  assert.doesNotMatch(s, /Register-ScheduledTask|Unregister-ScheduledTask|gh release create|Invoke-WebRequest|Invoke-RestMethod|Start-Process|Export-PfxCertificate/,
    "Probe must not register tasks, publish, contact services, execute a binary or export private keys");
}

test("MSIX has only developer-only full-trust package identity; no startup", () => {
  assertSafeManifest(manifest);
});

test("workflow is restricted to unprivileged PR on ephemeral hosted Windows", () => {
  assertNonPublishingWorkflow(workflow);
});

test("packaging script is isolated, tests install/removal, and never publishes", () => {
  assertEphemeralRunner(runner);
});

test("read-only preflight checks Windows prerequisites in a bounded child PowerShell", () => {
  assert.match(preflight, /GITHUB_HEAD_REF\?\.startsWith/);
  assert.match(preflight, /spawnSync\(/);
  assert.match(preflight, /env: windowsPowerShell51Environment\(environment\)/);
  assert.match(preflight, /Get-Command -Name/);
  assert.match(preflight, /Import-Module Microsoft\.PowerShell\.Security -ErrorAction Stop/);
  assert.match(preflight, /Get-PSDrive -Name Cert -ErrorAction SilentlyContinue/);
  assert.match(preflight, /timeout: 20_000/);
  assert.match(preflight, /MSIX_HOSTED_PREREQUISITES_NO_GO/);
  assert.doesNotMatch(preflight, /New-SelfSignedCertificate\s+@|Import-Certificate\s+-|Add-AppxPackage\s+-|Remove-AppxPackage\s+-/);
});

test("wrapper enforces bounded child execution and only the JSON report", () => {
  assert.match(bounded, /timeout: timeoutMs/);
  assert.match(bounded, /const timeoutMs = 120_000/);
  assert.match(bounded, /env: windowsPowerShell51Environment\(environment\)/);
  assert.match(bounded, /spawn\(/);
  assert.match(bounded, /powershell\.exe/);
  assert.match(bounded, /MSIX_PROBE_NO_GO/);
  assert.match(bounded, /GITHUB_HEAD_REF\?\.startsWith/);
  assert.doesNotMatch(bounded, /gh release|Store publish|Export-Pfx|https?:\/\//i);
});

test("negative controls reject publisher, auto-start and publication weakening", () => {
  const weakenedManifests = [
    manifest.replace("CN=Tetherplane MSIX Development Probe", "CN=Sohaib Labs"),
    manifest.replace("</Applications>", "<uap5:Extension Category=\"windows.startupTask\"/></Applications>"),
    manifest.replace('Name="runFullTrust"', 'Name="packagedServices"'),
  ];
  for (const weak of weakenedManifests) {
    assert.notEqual(weak, manifest);
    assert.throws(() => assertSafeManifest(weak));
  }
  const weakenedWorkflows = [
    workflow.replace("  contents: read", "  contents: write"),
    workflow.replace("on:\n  pull_request:", "on:\n  push:\n  pull_request:"),
    workflow.replace("run: node scripts/msix/ci-prerequisites.mjs", "run: echo skipped"),
    workflow.replace("github.event.pull_request.head.repo.full_name == github.repository", "true"),
    workflow.replace("path: ${{ runner.temp }}/tetherplane-msix-probe-report.json", "path: ${{ runner.temp }}/Tetherplane.MsixProbe.DevOnly.msix"),
  ];
  for (const weak of weakenedWorkflows) {
    assert.notEqual(weak, workflow);
    assert.throws(() => assertNonPublishingWorkflow(weak));
  }
  const weakenedRunners = [
    runner.replace("RUNNER_ENVIRONMENT -cne 'github-hosted'", "RUNNER_ENVIRONMENT -cne 'local'"),
    runner.replace("Add-AppxPackage -Path $packageFile", "Start-Process $source; Add-AppxPackage -Path $packageFile"),
    runner.replace("'Cert:\\LocalMachine\\TrustedPeople'", "'Cert:\\LocalMachine\\Root'"),
    runner.replace("(Get-Sha256Hex -Path $source)", "(Get-FileHash -LiteralPath $source)"),
    runner.replace("Import-Module Microsoft.PowerShell.Security -ErrorAction Stop", "Write-Output 'skip certificate provider'"),
  ];
  for (const weak of weakenedRunners) {
    assert.notEqual(weak, runner);
    assert.throws(() => assertEphemeralRunner(weak));
  }
});
