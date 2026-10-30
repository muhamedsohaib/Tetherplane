import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformStoreRuntime, assertApprovedScratchPath } from "../../scripts/msix-store/stage-store-runtime.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(repo, path), "utf8");
const manifest = read("packaging/msix-store-candidate/AppxManifest.xml");
const devManifest = read("packaging/msix-store-runtime/AppxManifest.xml");
const builder = read("scripts/msix-store/Build-StorePrivateCandidate.ps1");
const workflow = read(".github/workflows/msix-store-private-candidate.yml");

function attr(tag, key) {
  return new RegExp("\\b" + key + '="([^"]+)"').exec(tag)?.[1] ?? null;
}
function identityOf(xml) {
  return xml.match(/<Identity\b[^>]*\/>/s)?.[0] ?? null;
}

// Windows 10/11 Store MSIX uses four numeric parts. The Store reserves the
// fourth part as zero, and a zero major would fail Store version admission.
// Store package version is independent of the Rust/Node 0.1.0 product version.
function isValidStorePackageVersion(value) {
  const parts = value?.split(".") ?? [];
  return parts.length === 4
    && parts.every((part) => /^\d{1,5}$/.test(part) && Number(part) <= 65535)
    && Number(parts[0]) > 0
    && Number(parts[3]) === 0;
}

test("Store version is valid and remains pinned across manifest and operator packaging", () => {
  const version = attr(identityOf(manifest), "Version");
  assert.equal(version, "1.0.0.0");
  assert.equal(isValidStorePackageVersion(version), true);
  assert.match(builder, /\$version = '1\.0\.0\.0'/);
  for (const invalid of ["0.1.0.0", "1.0.0.1", "65536.0.0.0", "1.65536.0.0", "1.0.0", "1.-1.0.0", "1.0.0.65536"]) {
    assert.equal(isValidStorePackageVersion(invalid), false, invalid);
  }
});

test("Partner Center reserved identity, publisher and Store package version are exact", () => {
  const identity = identityOf(manifest);
  assert.ok(identity, "package identity missing");
  assert.equal(attr(identity, "Name"), "ARCUSLabs.Tetherplane");
  assert.equal(attr(identity, "Publisher"), "CN=6CCCFC81-2F0A-49BE-9027-A03BCF427F43");
  assert.equal(attr(identity, "ProcessorArchitecture"), "x64");
  assert.equal(attr(identity, "Version"), "1.0.0.0");
  assert.match(manifest, /<PublisherDisplayName>ARCUS Labs<\/PublisherDisplayName>/);
  assert.match(manifest, /<DisplayName>Tetherplane<\/DisplayName>/);
  assert.match(manifest, /<Resource Language="en-us"/);
  assert.match(manifest, /<TargetDeviceFamily Name="Windows.Desktop" MinVersion="10\.0\.22000\.0"/);
});

test("all Store executable and UI entries retain existing restricted app architecture", () => {
  const apps = [...manifest.matchAll(/<Application\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(apps.length, 2);
  assert.equal(attr(apps[0], "Id"), "Runtime");
  assert.equal(attr(apps[0], "Executable"), "bin\\tetherplane-setupw.exe");
  assert.equal(attr(apps[0], "uap11:Parameters"), null);
  assert.equal(attr(apps[0], "uap10:RuntimeBehavior"), "packagedClassicApp");
  assert.equal(attr(apps[0], "uap10:TrustLevel"), "mediumIL");
  assert.equal(attr(apps[1], "Id"), "Agent");
  assert.equal(attr(apps[1], "Executable"), "bin\\tetherd-agentw.exe");
  assert.equal(attr(apps[1], "uap10:RuntimeBehavior"), "packagedClassicApp");
  assert.equal(attr(apps[1], "uap10:TrustLevel"), "mediumIL");
  assert.match(manifest, /<uap:VisualElements AppListEntry="none" DisplayName="Tetherplane Agent"/);
  assert.equal((manifest.match(/<rescap:Capability\b/g) ?? []).length, 1);
  assert.match(manifest, /<Capabilities><rescap:Capability Name="runFullTrust" \/><\/Capabilities>/);
  assert.doesNotMatch(manifest, /packagedServices|localSystemServices|ExecutionAlias/i);
  const startupExtensions = [...manifest.matchAll(/<uap5:Extension\b[^>]*>/g)];
  const tasks = [...manifest.matchAll(/<uap5:StartupTask\b[^>]*\/>/g)];
  assert.equal(startupExtensions.length, 1, "exactly one startup extension");
  assert.equal(tasks.length, 1, "exactly one startup task");
  assert.equal(attr(startupExtensions[0][0], "Category"), "windows.startupTask");
  assert.equal(attr(startupExtensions[0][0], "Executable"), "bin\\tetherplane-autostartw.exe");
  assert.equal(attr(startupExtensions[0][0], "EntryPoint"), "Windows.FullTrustApplication");
  assert.equal(attr(tasks[0][0], "TaskId"), "TetherplaneOwnerAgentLogon");
  assert.equal(attr(tasks[0][0], "Enabled"), "false");
  assert.equal(attr(tasks[0][0], "DisplayName"), "Tetherplane Agent");
  const runtimeTag = manifest.match(/<Application Id="Runtime"[\s\S]*?<\/Application>/)?.[0];
  assert.ok(runtimeTag?.includes("windows.startupTask"),
    "startup must belong to owner-visible Runtime rather than hidden Agent");
  assert.doesNotMatch(manifest, /ImmediateRegistration|nonUserConfigurableStartupTasks/);
  assert.doesNotMatch(manifest, /Development Probe|DevOnly|\(DEV ONLY\)/i);
});

test("Store art is required as real assets, never silently inherited from dev square drawings", () => {
  for (const asset of ["Logo44.png", "Logo50.png", "Logo150.png"]) {
    assert.ok(manifest.includes("Assets\\" + asset));
    assert.ok(builder.includes(asset));
  }
  assert.match(builder, /ApprovedAssetsManifest/);
  assert.match(builder, /owner_approval_reference/);
  assert.match(builder, /STORE_CANDIDATE_ARTWORK_HASH_MISMATCH/);
  assert.match(builder, /CI_SYNTHETIC_PREVIEW_NOT_SUBMITTABLE/);
  assert.match(builder, /OWNER_CANDIDATE_NO_GO/);
  assert.match(builder, /NO_GO_CLEANUP_FAILED/);
  assert.match(builder, /STORE_CANDIDATE_STAGE_UI_FAILED/);
  assert.match(builder, /TetherplaneStoreDevOnly/);
  assert.match(builder, /TetherplaneStore/);
  assert.match(builder, /STORE_CANDIDATE_UNPACKED_DEVELOPMENT_TEXT_OR_STATE/);
  assert.match(builder, /STORE_CANDIDATE_RUNTIME_SELFTEST_FAILED/);
  assert.match(builder, /STORE_CANDIDATE_AGENT_MUST_HAVE_GUI_SUBSYSTEM/);
  assert.match(workflow, /scripts\/build-windows-agent-binaries\.ps1/);
  assert.match(workflow, /tetherd-agentw\.exe/);
  assert.match(workflow, /windows-store-setupw-lifecycle\.mjs/);
  assert.match(workflow, /windows-store-autostartw-lifecycle\.mjs/);
  assert.match(workflow, /-AutostartLauncherBinary/);
  assert.match(builder, /autostart_launcher_sha256/);
  assert.match(builder, /STORE_PROFILE_STARTUP_REQUIRES_EXPLICIT_OWNER_OPT_IN/);
  assert.match(workflow, /-SetupLauncherBinary/);
  assert.match(builder, /setup_launcher_sha256/);
});


test("Store-only overlay is deterministic, fail-closed and never alters development source", () => {
  const devJs = read("packaging/msix-store-runtime/app/runtime-app.mjs");
  const devUi = read("packaging/msix-store-runtime/app/setup.html");
  const storeJs = transformStoreRuntime("runtime-app.mjs", devJs);
  const storeUi = transformStoreRuntime("setup.html", devUi);
  assert.ok(devJs.includes("TetherplaneStoreDevOnly"));
  assert.ok(devUi.includes("DEVELOPMENT PREVIEW"));
  assert.ok(storeJs.includes('"TetherplaneStore"'));
  assert.ok(devJs.includes('join(packageRoot, "bin", "tetherd.exe")'));
  assert.ok(storeJs.includes('join(packageRoot, "bin", "tetherd-agentw.exe")'));
  assert.ok(storeJs.includes('"bin/tetherd-agentw.exe"'));
  assert.ok(storeJs.includes('"--owner-instance-lock"'));
  assert.ok(!devJs.includes('"--owner-instance-lock"'));
  assert.ok(read("packaging/msix-store-runtime/app/agent-autostart.mjs")
    .includes("readSavedConfig(stateRoot)"));
  assert.doesNotMatch(storeJs, /"bin\/tetherd\.exe"/);
  assert.doesNotMatch(storeJs, /TetherplaneStoreDevOnly/);
  assert.match(storeUi, /OWNER-APPROVED SETUP/);
  assert.doesNotMatch(storeUi, /DEVELOPMENT PREVIEW|Store-preview|not Microsoft Store-certified/);
  assert.throws(
    () => transformStoreRuntime("runtime-app.mjs", storeJs),
    /STORE_UI_SOURCE_CONTRACT_DRIFT/
  );
  assert.throws(() => assertApprovedScratchPath(repo), /STORE_UI_STAGE_DENIED_OUTSIDE_PRIVATE_SCRATCH/);
  assert.doesNotThrow(() => assertApprovedScratchPath(
    join(repo, "tetherplane-store-private-" + "a".repeat(32), "payload", "app")
  ));
});

test("original synthetic Store-runtime feasibility identity remains untouched", () => {
  const devIdentity = identityOf(devManifest);
  assert.equal(attr(devIdentity, "Name"), "Tetherplane.StoreRuntime.DevOnly");
  assert.equal(attr(devIdentity, "Publisher"), "CN=Tetherplane MSIX Development Probe");
  assert.notEqual(devManifest, manifest);
});

test("new packaging CI cannot publish, install packages, alter trust, or upload MSIX binaries", () => {
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /feature\/msix-store-private-candidate-/);
  // Require the two Store jobs to run for this exact reviewed combined head.
  const exactReviewBranch = "fix/windows-zero-console-model-worker-20261030";
  assert.equal(workflow.split("github.head_ref == '" + exactReviewBranch + "'").length - 1, 2);
  assert.equal(workflow.split("github.head_ref == 'fix/store-windowless-owner-setup-20261030'").length - 1, 2);
  assert.equal(workflow.split("github.head_ref == 'fix/store-owner-opt-in-autostart-20261030'").length - 1, 2);
  assert.ok(builder.includes("$candidateHead -ceq 'fix/store-owner-opt-in-autostart-20261030'"));
  assert.ok(builder.includes("$candidateHead -ceq 'fix/store-windowless-owner-setup-20261030'"));
  assert.ok(builder.includes("$candidateHead -ceq '" + exactReviewBranch + "'"));
  assert.ok(builder.includes("-not $approvedCiRef"));
  assert.ok(read("tests/release/msix-store-runtime-real-relay.test.mjs")
    .includes('process.env.GITHUB_HEAD_REF === "' + exactReviewBranch + '"'));
  assert.match(workflow, /CI_PACKAGE_STRUCTURE_PASS_NOT_SUBMITTABLE/);
  const ownerInstructions = read("packaging/msix-store-runtime/app/setup.html");
  assert.match(ownerInstructions, /Windows Settings &gt; Apps &gt; Startup/);
  assert.match(ownerInstructions, /disabled by default/);
  assert.doesNotMatch(workflow, /^\s*(?:&\s*)?(?:Add-AppxPackage|Import-Certificate|New-SelfSignedCertificate)\b/gim);
  assert.doesNotMatch(workflow, /workflow_dispatch|push:\s*\n|contents: write|SignTool sign/i);
  assert.doesNotMatch(workflow, /\.msix\b.*upload-artifact|upload-artifact.*\.msix\b/i);
  assert.doesNotMatch(builder, /Add-AppxPackage|Import-Certificate|New-SelfSignedCertificate|Start-ScheduledTask|Register-ScheduledTask|Set-MpPreference|Set-ExecutionPolicy/);
  assert.match(builder, /owner_submission_approval = 'NOT_GRANTED'/);
  assert.match(builder, /native_SAC_On_acceptance = 'NOT_RUN'/);
});

test("screenshot and certification are independently gated", () => {
  const checklist = read("docs/release/MSIX_STORE_PRIVATE_CANDIDATE_20261028.md");
  for (const gate of ["genuine", "Smart App Control", "Partner Center", "rollback", "Microsoft Store", "NO-GO"]) {
    assert.ok(checklist.includes(gate), "Missing release gate: " + gate);
  }
});

test("owner review MSIX is not exported until scratch package passes every integrity gate", () => {
  const marks = [
    "Tetherplane.OWNER-REVIEW.STAGED.UNSIGNED.msix",
    "STORE_CANDIDATE_RUNTIME_SELFTEST_FAILED",
    "STORE_CANDIDATE_UNPACKED_RUNTIME_HASH_MISMATCH",
    "STORE_CANDIDATE_PROVENANCE_FAILED",
    "$report.unpack_integrity = 'PASS'",
    "STORE_CANDIDATE_EXPORT_HASH_MISMATCH",
    "[IO.File]::Move($exportTemp, $ownerOutput)"
  ];
  let previous = -1;
  for (const marker of marks) {
    const position = builder.indexOf(marker);
    assert.ok(position > previous, marker + " must follow previous verification/export stage");
    previous = position;
  }
  assert.match(builder, /\[IO\.FileMode\]::CreateNew/);
  assert.match(builder, /\$exportOwned = true|\$exportOwned = \$true/);
  assert.match(builder, /if \(\$exportOwned -and \(Test-Path -LiteralPath \$exportTemp -PathType Leaf\)\)/);
  assert.doesNotMatch(builder, /& \$makeAppx pack \/d \$payload \/p \$ownerOutput/);
});


test("real relay Windows integration targets the reviewed windowless executable", () => {
  const smoke = read("tests/release/msix-store-runtime-real-relay.test.mjs");
  assert.match(smoke, /resolve\("target", "release", "tetherd-agentw\.exe"\)/);
  assert.match(smoke, /MSIX_REAL_RELAY_REQUIRED_TEST_INELIGIBLE/);
  assert.match(workflow, /TETHERPLANE_REQUIRE_MSIX_REAL_RELAY: '1'/);
  assert.ok(smoke.includes('process.env.GITHUB_HEAD_REF === "fix/store-windowless-owner-setup-20261030"'));
  assert.ok(smoke.includes('process.env.GITHUB_HEAD_REF === "fix/store-owner-opt-in-autostart-20261030"'));
  assert.match(manifest, /Executable="bin\\tetherplane-setupw\.exe"/);
  assert.doesNotMatch(manifest, /Executable="runtime\\node\.exe"/);
});
