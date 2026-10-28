import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

test("Partner Center reserved identity, publisher and Store package version are exact", () => {
  const identity = identityOf(manifest);
  assert.ok(identity, "package identity missing");
  assert.equal(attr(identity, "Name"), "ARCUSLabs.Tetherplane");
  assert.equal(attr(identity, "Publisher"), "CN=6CCCFC81-2F0A-49BE-9027-A03BCF427F43");
  assert.equal(attr(identity, "ProcessorArchitecture"), "x64");
  assert.equal(attr(identity, "Version"), "0.1.0.0");
  assert.match(manifest, /<PublisherDisplayName>ARCUS Labs<\/PublisherDisplayName>/);
  assert.match(manifest, /<DisplayName>Tetherplane<\/DisplayName>/);
  assert.match(manifest, /<Resource Language="en-us"/);
  assert.match(manifest, /<TargetDeviceFamily Name="Windows.Desktop" MinVersion="10\.0\.22000\.0"/);
});

test("all Store executable and UI entries retain existing restricted app architecture", () => {
  const apps = [...manifest.matchAll(/<Application\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(apps.length, 2);
  assert.equal(attr(apps[0], "Id"), "Runtime");
  assert.equal(attr(apps[0], "Executable"), "runtime\\node.exe");
  assert.equal(attr(apps[0], "uap10:RuntimeBehavior"), "packagedClassicApp");
  assert.equal(attr(apps[0], "uap10:TrustLevel"), "mediumIL");
  assert.equal(attr(apps[1], "Id"), "Agent");
  assert.equal(attr(apps[1], "Executable"), "bin\\tetherd.exe");
  assert.equal(attr(apps[1], "uap10:RuntimeBehavior"), "packagedClassicApp");
  assert.equal(attr(apps[1], "uap10:TrustLevel"), "mediumIL");
  assert.match(manifest, /<uap:VisualElements AppListEntry="none" DisplayName="Tetherplane Agent"/);
  assert.equal((manifest.match(/<rescap:Capability\b/g) ?? []).length, 1);
  assert.match(manifest, /<Capabilities><rescap:Capability Name="runFullTrust" \/><\/Capabilities>/);
  assert.doesNotMatch(manifest, /startupTask|packagedServices|localSystemServices|ExecutionAlias|windows\.fullTrustApplication/i);
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
  assert.match(builder, /STORE_CANDIDATE_SOURCE_UI_OR_STATE_TRANSFORM_DRIFT/);
  assert.match(builder, /TetherplaneStoreDevOnly/);
  assert.match(builder, /TetherplaneStore/);
  assert.match(builder, /STORE_CANDIDATE_UNPACKED_DEVELOPMENT_TEXT_OR_STATE/);
  assert.match(builder, /STORE_CANDIDATE_RUNTIME_SELFTEST_FAILED/);
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
  assert.match(workflow, /CI_PACKAGE_STRUCTURE_PASS_NOT_SUBMITTABLE/);
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
