/**
 * Disposable Windows Chrome broker-crash acceptance.
 *
 * Exercises the actual Tetherplane CDP launcher. The parent forcibly terminates
 * its own test broker, then independently checks the browser process tree.
 * It never touches human browser profiles or the installed tetherd agent.
 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const RUNNER = fileURLToPath(import.meta.url);
const PAUSE = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function testOwnedBrowserProcessIds(profileParent) {
  // Match an unpredictable test-only profile directory and chrome.exe, never
  // broadly enumerate/terminate all browsers or reuse human browser profiles.
  const safe = profileParent.replaceAll("'", "''");
  const query =
    "$parent='" + safe + "';" +
    "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" " +
    "|Where-Object {$_.CommandLine -like \"*$parent*\"} " +
    "|Select-Object -ExpandProperty ProcessId";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", query],
    { timeout: 12_000, windowsHide: true },
  );
  return stdout.split(/\r?\n/).map((s) => Number(s.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

async function ownedTcpListenerCount(pids) {
  const ids = pids.join(",");
  const command =
    "$owned=@(" + ids + ");" +
    "Write-Output (@(Get-NetTCPConnection -State Listen -ErrorAction Stop " +
    "|Where-Object {$owned -contains $_.OwningProcess}).Count)";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { timeout: 12_000, windowsHide: true },
  );
  const value = Number(stdout.trim());
  assert.ok(Number.isSafeInteger(value) && value >= 0, "TCP listener inspection failed");
  return value;
}

async function forceCleanupOwnedBrowser(profileParent) {
  const safe = profileParent.replaceAll("'", "''");
  const command =
    "$parent='" + safe + "';" +
    "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" " +
    "|Where-Object {$_.CommandLine -like \"*$parent*\"} " +
    "|ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}";
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { timeout: 12_000, windowsHide: true },
  );
}

async function runChild() {
  if (process.env.TP_CDP_CRASH_LAB !== "1") throw new Error("LAB_OPT_IN_REQUIRED");
  const parentDir = process.env.TP_CDP_CRASH_PARENT;
  if (!parentDir || !existsSync(parentDir)) throw new Error("INVALID_LAB_PARENT");
  const { launchCdpOwnedBrowser } = await import("../browser/bridge/src/index.ts");
  const control = await launchCdpOwnedBrowser({
    executablePath: CHROME,
    profileParent: parentDir,
    launchTimeoutMs: 20_000,
    privatePipe: true,
  });
  process.stdout.write("TP_CDP_CRASH_READY=" + control.profile_dir + "\n");
  // Deliberately no finally/close: the parent kills this broker abruptly.
  // Its private CDP channel will disappear when the broker is terminated.
  await new Promise(() => undefined);
}

async function readyProfile(child, timeoutMs) {
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk).slice(0, 500); });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("BROKER_NOT_READY")), timeoutMs);
    const onData = (chunk) => {
      stdout += String(chunk);
      const found = /TP_CDP_CRASH_READY=(.+)\r?\n/.exec(stdout);
      if (found) finish(null, found[1].trim());
    };
    const onExit = (code) => finish(new Error("BROKER_EXITED_BEFORE_READY_" + String(code) + "_" + stderr.slice(0, 120)));
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(value);
    }
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("BROKER_KILL_TIMEOUT")), timeoutMs)),
  ]);
}

async function main() {
  if (process.platform !== "win32") {
    console.log(JSON.stringify({ result: "SKIPPED_NON_WINDOWS" }));
    return;
  }
  assert.ok(existsSync(CHROME), "Windows Chrome is required");
  const parentDir = await mkdtemp(path.join(os.tmpdir(), "tp-cdp-broker-crash-"));
  const report = {
    result: "FAILED",
    ownedBeforeCrash: 0,
    rawTcpListenerCount: null,
    devtoolsPortFile: null,
    ownedAfterCrash: null,
    recoveryMs: null,
    disposedProfile: false,
  };
  let child;
  try {
    child = spawn(process.execPath, [RUNNER, "--broker"], {
      env: {
        ...process.env,
        TP_CDP_CRASH_LAB: "1",
        TP_CDP_CRASH_PARENT: parentDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const profile = await readyProfile(child, 25_000);
    assert.ok(path.resolve(profile).startsWith(path.resolve(parentDir) + path.sep));
    const active = await testOwnedBrowserProcessIds(parentDir);
    report.ownedBeforeCrash = active.length;
    assert.ok(active.length > 0, "test cannot prove recovery without a live owned browser");
    // An independent Windows process enumerates Chrome-owned TCP listeners:
    // a DevToolsActivePort file check alone cannot prove no raw CDP endpoint.
    report.devtoolsPortFile = existsSync(path.join(profile, "DevToolsActivePort"));
    report.rawTcpListenerCount = await ownedTcpListenerCount(active);
    assert.equal(report.devtoolsPortFile, false, "raw DevTools TCP metadata exists");
    assert.equal(report.rawTcpListenerCount, 0, "Chrome exposes a listening TCP endpoint");

    const crashStart = Date.now();
    assert.equal(child.kill("SIGKILL"), true, "failed to terminate disposable test broker");
    await waitForExit(child, 7_000);
    let survivors = await testOwnedBrowserProcessIds(parentDir);
    const limit = Date.now() + 6_000;
    while (survivors.length > 0 && Date.now() < limit) {
      await PAUSE(250);
      survivors = await testOwnedBrowserProcessIds(parentDir);
    }
    report.ownedAfterCrash = survivors.length;
    report.recoveryMs = Date.now() - crashStart;
    assert.deepEqual(survivors, [], "Chrome survived the crashed private-CDP broker");
    report.result = "PASSED";
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
    // A failing test must still clean up only its own test browser and profile.
    try { await forceCleanupOwnedBrowser(parentDir); }
    catch (error) { report.cleanupError = String(error).slice(0, 150); }
    try { await rm(parentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
    catch (error) { report.cleanupError = String(error).slice(0, 150); }
    report.disposedProfile = !existsSync(parentDir);
    console.log(JSON.stringify(report));
  }
}

if (process.argv.includes("--broker")) {
  await runChild();
} else {
  await main();
}
