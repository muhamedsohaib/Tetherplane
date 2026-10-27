import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const txt = name => readFileSync(new URL("../../"+name,import.meta.url),"utf8").replace(/\r\n/g,"\n");
const manifest=txt("packaging/msix-store-runtime/AppxManifest.xml");
const app=txt("packaging/msix-store-runtime/app/runtime-app.mjs");
const script=txt("scripts/msix-store/Test-TetherplaneStoreRuntime.ps1");
const wrapper=txt("scripts/msix-store/run-bounded-runtime-probe.mjs");
const preflight=txt("scripts/msix-store/ci-prerequisites.mjs");
const workflow=txt(".github/workflows/msix-store-runtime-g2.yml");

test("MSIX uses a distinct synthetic developer identity and real onboarding entry, no silent startup",()=>{
  assert.match(manifest,/Name="Tetherplane\.StoreRuntime\.DevOnly"/);
  assert.match(manifest,/Publisher="CN=Tetherplane MSIX Development Probe"/);
  assert.match(manifest,/Executable="runtime\\node\.exe"/);
  assert.match(manifest,/uap11:Parameters="app\\runtime-app\.mjs"/);
  assert.match(manifest,/uap11:CurrentDirectoryPath="\$\(package\.installedPath\)"/);
  assert.match(manifest,/RuntimeBehavior="packagedClassicApp"/);
  assert.match(manifest,/TrustLevel="mediumIL"/);
  assert.match(manifest,/runFullTrust/);
  assert.doesNotMatch(manifest,/startupTask|packagedServices|localSystemServices|broadFileSystemAccess/i);
});

test("first-run client must require existing owner approval without collecting OAuth tokens",()=>{
  assert.match(app,/\/pair\/start/);
  assert.match(app,/credentialHash/);
  assert.match(app,/I APPROVED THIS DEVICE/);
  assert.match(app,/x-tetherplane-setup/);
  assert.match(app,/origin !== origin/);
  assert.match(app,/connected: "not_verified"/);
  assert.match(app,/referrer-policy.*no-referrer/);
  assert.doesNotMatch(app,/\/pair\/approve|Register-ScheduledTask|Unregister-ScheduledTask/);
});

test("package contains native agent, signed Node runtime, licence, onboarding app and production MCP edge",()=>{
  assert.match(script,/Get-AuthenticodeSignature -FilePath \$nodeSource/);
  assert.match(script,/Node\.js license notice is missing/);
  assert.match(script,/Copy-Item -LiteralPath \$nodeSource/);
  assert.match(script,/Copy-Item -Path \(Join-Path \$onboardingSource '\*'\)/);
  assert.match(script,/Copy-Item -LiteralPath \$compactSource/);
  assert.match(script,/Get-Sha256Hex -Path \(Join-Path \$unpacked \$check\.Unpacked\)/);
  assert.match(script,/bundled_runtime_self_test_started/);
  assert.match(script,/payload_self_test = 'PASS'/);
  assert.match(script,/Add-AppxPackage -Path \$packageFile/);
  assert.match(script,/Remove-AppxPackage -Package \$installedFullName/);
});

test("CI is PR-only, read-only token, exact branch, data-only artifacts",()=>{
  assert.match(workflow,/^on:\n  pull_request:/m);
  assert.match(workflow,/^permissions:\n  contents: read/m);
  assert.match(workflow,/feature\/msix-store-runtime-/);
  assert.match(workflow,/actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow,/node --test tests\/release\/msix-store-runtime\.test\.mjs/);
  assert.match(workflow,/cargo build --release --locked -p tetherd/);
  assert.match(workflow,/run: node scripts\/msix-store\/run-bounded-runtime-probe\.mjs/);
  assert.match(workflow,/tetherplane-msix-runtime-g2-report\.json/);
  assert.doesNotMatch(workflow,/(?:gh release create|store publish|contents: write|secrets\.|workflow_dispatch:|on:\n  push:)/i);
  assert.doesNotMatch(workflow,/(?:path|upload):\s*.*\.(?:msix|exe|pfx|cer)\b/i);
});

test("Windows runner guarded and ephemeral; no startup or credential import",()=>{
  assert.match(script,/GITHUB_ACTIONS -cne 'true'/);
  assert.match(script,/RUNNER_ENVIRONMENT -cne 'github-hosted'/);
  assert.match(script,/feature\/msix-store-runtime-/);
  assert.match(script,/Join-Path \$env:RUNNER_TEMP/);
  assert.match(script,/certificate_cleanup/);
  assert.match(script,/Source = \$nodeSource/);
  assert.match(wrapper,/feature\/msix-store-runtime-/);
  assert.match(wrapper,/timeout: timeoutMs/);
  assert.match(preflight,/GITHUB_HEAD_REF\?\.startsWith/);
  assert.doesNotMatch(script,/Cert:\\(?:CurrentUser|LocalMachine)\\Root/);
  assert.doesNotMatch(script,/Register-ScheduledTask|Unregister-ScheduledTask|Export-PfxCertificate|gh release create/);
});

test("negative controls detect permission and metadata weakening",()=>{
  assert.notEqual(manifest.replace("Tetherplane.StoreRuntime.DevOnly","Tetherplane.Live"),manifest);
  assert.doesNotMatch(manifest,/Enabled="true"/);
  const wrong=manifest.replace('Name="runFullTrust"','Name="broadFileSystemAccess"');
  assert.doesNotMatch(wrong,/<rescap:Capability Name="runFullTrust"/);
  const loosened=workflow.replace("contents: read","contents: write");
  assert.match(loosened,/contents: write/);
});
