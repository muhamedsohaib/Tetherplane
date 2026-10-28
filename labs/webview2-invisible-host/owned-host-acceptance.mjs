// Windows-only, explicitly invoked native WebView2 typed-host acceptance.
// No user browser profiles, external URLs, credentials, shells, or production agent.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  BrowserOwnershipRegistry,
  SemanticSnapshotEngine,
  VerifiedActionEngine,
} from "../../browser/bridge/src/index.ts";
import { WebView2OwnedFixtureBackend } from "../../browser/bridge/src/webview2-owned-fixture.ts";

if (process.platform !== "win32") throw new Error("WINDOWS_REQUIRED");

const executable = process.argv[2];
if (!executable || !existsSync(executable)) throw new Error("WEBVIEW2_TYPED_HOST_EXECUTABLE_MISSING");
const root = await mkdtemp(path.join(os.tmpdir(), "tp-webview2-owned-host-"));
const profile = path.join(root, "profile");
let child;
let requestId = 0;
const pending = new Map();
const report = {
  hostReady: false,
  created: false,
  observed: false,
  clickVerified: false,
  foreignPageDenied: false,
  remoteNavigationDenied: false,
  duplicateCreateDenied: false,
  closeVerified: false,
  missingCapabilityDenied: false,
  invalidCapabilityDenied: false,
  unactivatedFixtureDenied: false,
  localGrantActivated: false,
  nativeRevocationAcknowledged: false,
  nativeRevocationEnforced: false,
  ownedProcessesAfter: null,
  removedProfile: false,
  result: "FAIL",
};
try {
  child = spawn(executable, [profile], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    cwd: path.dirname(executable),
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("NATIVE_HOST_READY_TIMEOUT")), 15000);
    const onExit = () => { clearTimeout(timer); reject(new Error("NATIVE_HOST_EARLY_EXIT")); };
    child.once("exit", onExit);
    reader.on("line", function onLine(line) {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.ready === true) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(message);
        return;
      }
      const request = pending.get(String(message.id));
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(String(message.id));
      request.resolve(message);
    });
  });
  const hello = await ready;
  report.hostReady = true;
  // A granted capability is never supplied in args, environment, process
  // arguments, or diagnostic output. Only the parent receives it on stdout.
  let sessionCapability = null;
  async function request(method, args = {}, capability = sessionCapability) {
    const id = String(++requestId);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("NATIVE_HOST_REPLY_TIMEOUT_" + method));
      }, 9000);
      pending.set(id, { resolve, timer });
    });
    const envelope = { id, method, args };
    if (capability !== null) envelope.capability = capability;
    child.stdin.write(JSON.stringify(envelope) + "\n");
    return result;
  }
  // These are observable deny-before-side-effect tests against the *real*
  // native process. The existing host accepts an unauthorized create and
  // therefore correctly fails this test before the new handshake exists.
  const beforeAuth = await request("create_fixture");
  assert.equal(beforeAuth.error?.code, "permission_denied");
  report.missingCapabilityDenied = true;
  assert.match(hello.capability, /^[a-f0-9]{64}$/i);
  const invalidAuth = await request("create_fixture", {}, "0".repeat(64));
  assert.equal(invalidAuth.error?.code, "permission_denied");
  report.invalidCapabilityDenied = true;
  sessionCapability = hello.capability;
  const unactivated = await request("create_fixture");
  assert.equal(unactivated.error?.code, "permission_denied");
  report.unactivatedFixtureDenied = true;
  const activation = await request("activate_fixture", { lifetime_ms: 60000 });
  assert.equal(activation.data?.active, true);
  report.localGrantActivated = true;

  // These operations pass through the actual Tetherplane policy adapter,
  // semantic snapshot engine, ownership registry and verified-action engine.
  // Only the narrow injected transport below understands the host's envelope;
  // the native host never receives unrestricted model/browser commands.
  const transport = {
    async request(method, args) {
      const response = await request(method, args);
      return response.error ? { error: response.error } : response.data ?? {};
    },
  };
  const backend = new WebView2OwnedFixtureBackend({
    transport,
    expiresAtMs: Date.now() + 45_000,
  });
  const created = await backend.createPage();
  const page = created.page_id;
  assert.match(page, /^wvlab:[A-Za-z0-9_-]{6,128}$/);
  assert.equal(created.url, "about:blank");
  assert.equal(created.ownership, "tetherplane");
  assert.equal(created.active, false);
  report.created = true;

  const observed = await backend.observe(page);
  assert.equal(observed.page_id, page);
  assert.equal(observed.nodes.find((n) => n.role === "status")?.accessible_name, "initial");
  report.observed = true;
  const duplicate = await request("create_fixture");
  assert.equal(duplicate.error?.code, "permission_denied");
  report.duplicateCreateDenied = true;
  const foreign = await request("observe_fixture", { page_id: "wvlab:foreign12345" });
  assert.equal(foreign.error?.code, "permission_denied");
  await assert.rejects(backend.observe("wvlab:foreign12345"), { code: "permission_denied" });
  report.foreignPageDenied = true;
  const remote = await request("navigate", { page_id: page, url: "https://example.com/" });
  assert.equal(remote.error?.code, "capability_unavailable");
  await assert.rejects(
    backend.perform(page, { kind: "navigate", url: "https://example.com/" }),
    { code: "capability_unavailable" },
  );
  report.remoteNavigationDenied = true;

  const semantics = new SemanticSnapshotEngine();
  const button = semantics.snapshot(observed.nodes, {
    revision: observed.semantic_revision,
  }).nodes.find((n) => n.role === "button" && n.accessible_name === "GO");
  assert.ok(button?.ref);
  const ownership = new BrowserOwnershipRegistry();
  ownership.register({ page_id: page, ownership: "tetherplane", active: false });
  const verifiedEngine = new VerifiedActionEngine({ backend, semantics, ownership });
  const action = await verifiedEngine.execute({
    page_id: page,
    mode: "background_only",
    actions: [{ kind: "click", target: button.ref }],
    expectations: [{ kind: "text", includes: "clicked" }],
  });
  assert.equal(action.state, "verified");
  assert.ok(action.after_semantic_revision > action.before_semantic_revision);
  const result = await request("observe_fixture", { page_id: page });
  assert.equal(result.data?.status, "clicked");
  report.clickVerified = true;
  const beforeClose = await backend.observe(page);
  assert.equal(beforeClose.semantic_revision, 2);

  // A native grant must remain revocable even when the caller still knows the
  // private session capability. This is an actual host-side negative test,
  // not a TypeScript-only policy denial.
  const revoked = await request("revoke_fixture");
  assert.equal(revoked.data?.revoked, true);
  report.nativeRevocationAcknowledged = true;
  const afterRevocation = await request("observe_fixture", { page_id: page });
  assert.equal(afterRevocation.error?.code, "permission_denied");
  report.nativeRevocationEnforced = true;
  const reactivation = await request("activate_fixture", { lifetime_ms: 60000 });
  assert.equal(reactivation.error?.code, "permission_denied");

  // Ownership cleanup must stay available even after a grant is revoked.
  await backend.closePage(page);
  const after = await request("observe_fixture", { page_id: page });
  assert.equal(after.error?.code, "permission_denied");
  await assert.rejects(backend.observe(page), { code: "permission_denied" });
  report.closeVerified = true;
  const shutdown = await request("shutdown");
  assert.equal(shutdown.data?.stopping, true);
  report.result = "PASS_PENDING_CLEANUP";
} catch (error) {
  report.error = String(error?.message ?? error).slice(0, 180);
} finally {
  for (const [,p] of pending) clearTimeout(p.timer);
  if (child && child.exitCode === null) {
    try { child.kill(); } catch {}
  }
  const safe = profile.replaceAll("'", "''");
  const cleanup =
    "$r='" + safe + "';" +
    "$p=@(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe' OR Name = 'WebView2OwnedHost.exe'\" " +
    "|Where-Object {$_.CommandLine -like \"*$r*\"});" +
    "foreach($x in $p){Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue};" +
    "Start-Sleep -Milliseconds 400;" +
    "$left=@(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe' OR Name = 'WebView2OwnedHost.exe'\" " +
    "|Where-Object {$_.CommandLine -like \"*$r*\"});Write-Output $left.Count";
  try {
    const stdout = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", cleanup],
      { encoding: "utf8", timeout: 10000 });
    report.ownedProcessesAfter = Number(stdout.trim());
  } catch (e) { report.cleanupError = "PROCESS_CLEANUP_UNVERIFIED"; }
  try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch (e) { report.cleanupError = "TEMP_PROFILE_CLEANUP_FAILED"; }
  report.removedProfile = !existsSync(root);
  if (report.result === "PASS_PENDING_CLEANUP" &&
      report.ownedProcessesAfter === 0 && report.removedProfile) report.result = "PASS";
  else report.result = "FAIL";
  console.log(JSON.stringify(report));
}
if (report.result !== "PASS") process.exitCode = 1;
