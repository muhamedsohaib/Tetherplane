// Disposable Windows-only process-death and raw-listener acceptance.
// Never targets human windows or profiles. Requires only its own test host.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform !== "win32") throw new Error("WINDOWS_REQUIRED");
const exe = process.argv[2];
if (!exe || !existsSync(exe)) throw new Error("OWNED_WEBVIEW2_HOST_MISSING");
const root = await mkdtemp(path.join(os.tmpdir(), "tp-owned-host-death-"));
const profile = path.join(root, "profile");
const report = {
  before: null,
  listeningTcp: null,
  unsafeDebugFlag: null,
  noSandboxFlag: null,
  survivingAfterHostDeath: null,
  recoveryMs: null,
  survivorsAfterForcedCleanup: null,
  profileRemoved: false,
  verdict: "FAIL",
};
let child;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function inspectOwned() {
  const safe = profile.replaceAll("'", "''");
  const ps = [
    "$r='" + safe + "'",
    "$p=@(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" |Where-Object {$_.CommandLine -like \"*$r*\"})",
    "$ids=@($p|Select-Object -ExpandProperty ProcessId)",
    "$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop |Where-Object {$ids -contains $_.OwningProcess})",
    "$debugFlag=@($p|Where-Object {$_.CommandLine -like '*--remote-debugging-port=*'}).Count -gt 0",
    "$sandboxFlag=@($p|Where-Object {$_.CommandLine -like '*--no-sandbox*'}).Count -gt 0",
    "[pscustomobject]@{count=$p.Count;listeners=$listeners.Count;debug=$debugFlag;noSandbox=$sandboxFlag}|ConvertTo-Json -Compress",
  ].join(";");
  const stdout = execFileSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", timeout: 15000, windowsHide: true });
  return JSON.parse(stdout.trim());
}
function cleanOwned() {
  const safe = profile.replaceAll("'", "''");
  const ps = [
    "$r='" + safe + "'",
    "$p=@(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" |Where-Object {$_.CommandLine -like \"*$r*\"})",
    "foreach($x in $p){Stop-Process -Id $x.ProcessId -Force -ErrorAction SilentlyContinue}",
    "Start-Sleep -Milliseconds 350",
    "$left=@(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" |Where-Object {$_.CommandLine -like \"*$r*\"})",
    "Write-Output $left.Count",
  ].join(";");
  const result = execFileSync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { encoding: "utf8", timeout: 15000, windowsHide: true });
  return Number(result.trim());
}
try {
  child = spawn(exe, [profile], {
    windowsHide: true,
    cwd: path.dirname(exe),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("HOST_START_TIMEOUT")), 15000);
    child.once("exit", () => reject(new Error("HOST_EXITED_BEFORE_READY")));
    reader.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.ready !== true) return;
        clearTimeout(timeout);
        resolve(message);
      } catch {}
    });
  });
  const hello = await ready;
  assert.match(hello.capability, /^[a-f0-9]{64}$/i);
  async function request(id, method, args = {}) {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reader.off("line", onLine);
        reject(new Error("HOST_COMMAND_TIMEOUT_" + method));
      }, 9000);
      function onLine(line) {
        let response;
        try { response = JSON.parse(line); } catch { return; }
        if (response.id !== id) return;
        clearTimeout(timeout);
        reader.off("line", onLine);
        resolve(response);
      }
      reader.on("line", onLine);
      child.stdin.write(JSON.stringify({
        id, method, args, capability: hello.capability,
      }) + "\n");
    });
  }
  const activation = await request("0", "activate_fixture", { lifetime_ms: 60000 });
  assert.equal(activation.data?.active, true);
  const created = await request("1", "create_fixture");
  assert.match(created.data?.page_id, /^wvlab:[A-Za-z0-9_-]{6,128}$/);
  const before = inspectOwned();
  report.before = before.count;
  report.listeningTcp = before.listeners;
  report.unsafeDebugFlag = before.debug;
  report.noSandboxFlag = before.noSandbox;
  assert.ok(before.count > 0, "not a meaningful crash test without a real owned browser");
  assert.equal(before.listeners, 0, "test browser owns a listening TCP socket");
  assert.equal(before.debug, false, "test browser exposed raw CDP TCP switch");
  assert.equal(before.noSandbox, false, "test browser disabled sandbox");

  const crashAt = Date.now();
  assert.equal(child.kill("SIGKILL"), true);
  let owned = inspectOwned().count;
  const deadline = Date.now() + 6500;
  while (owned > 0 && Date.now() < deadline) {
    await sleep(250);
    owned = inspectOwned().count;
  }
  report.survivingAfterHostDeath = owned;
  report.recoveryMs = Date.now() - crashAt;
  assert.equal(owned, 0, "WebView2 browser processes survived the crashed test host");
  report.verdict = "PASS_PENDING_CLEANUP";
} catch (error) {
  report.error = String(error?.message ?? error).slice(0, 180);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch {}
  }
  try { report.survivorsAfterForcedCleanup = cleanOwned(); }
  catch { report.cleanupError = "UNVERIFIED_PROCESS_CLEANUP"; }
  try { await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }); }
  catch { report.cleanupError = "PROFILE_CLEANUP_FAILED"; }
  report.profileRemoved = !existsSync(root);
  if (report.verdict === "PASS_PENDING_CLEANUP" &&
      report.survivorsAfterForcedCleanup === 0 && report.profileRemoved)
    report.verdict = "PASS";
  else report.verdict = "FAIL";
  console.log(JSON.stringify(report));
}
if (report.verdict !== "PASS") process.exitCode = 1;
