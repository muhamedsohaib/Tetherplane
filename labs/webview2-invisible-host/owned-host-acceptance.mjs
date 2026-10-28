// Windows-only, explicitly invoked native WebView2 typed-host acceptance.
// No user browser profiles, external URLs, credentials, shells, or production agent.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

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
  await ready;
  report.hostReady = true;
  async function request(method, args = {}) {
    const id = String(++requestId);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("NATIVE_HOST_REPLY_TIMEOUT_" + method));
      }, 9000);
      pending.set(id, { resolve, timer });
    });
    child.stdin.write(JSON.stringify({ id, method, args }) + "\n");
    return result;
  }
  const created = await request("create_fixture");
  const page = created.data?.page_id;
  assert.ok(typeof page === "string" && /^wvlab:[A-Za-z0-9_-]{6,128}$/.test(page));
  assert.equal(created.data?.url, "about:blank");
  report.created = true;

  const observed = await request("observe_fixture", { page_id: page });
  assert.equal(observed.data?.page_id, page);
  assert.equal(observed.data?.status, "initial");
  report.observed = true;
  const duplicate = await request("create_fixture");
  assert.equal(duplicate.error?.code, "permission_denied");
  report.duplicateCreateDenied = true;
  const foreign = await request("observe_fixture", { page_id: "wvlab:foreign12345" });
  assert.equal(foreign.error?.code, "permission_denied");
  report.foreignPageDenied = true;
  const remote = await request("navigate", { page_id: page, url: "https://example.com/" });
  assert.equal(remote.error?.code, "capability_unavailable");
  report.remoteNavigationDenied = true;
  const clicked = await request("click_fixture", { page_id: page, element: "go" });
  assert.equal(clicked.data?.clicked, true);
  const result = await request("observe_fixture", { page_id: page });
  assert.equal(result.data?.status, "clicked");
  assert.ok(result.data.revision > observed.data.revision);
  report.clickVerified = true;
  const closed = await request("close_fixture", { page_id: page });
  assert.equal(closed.data?.closed, true);
  const after = await request("observe_fixture", { page_id: page });
  assert.equal(after.error?.code, "permission_denied");
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
