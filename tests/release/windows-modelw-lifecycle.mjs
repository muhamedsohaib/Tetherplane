// Disposable Windows native model-worker GUI launch without real model or
// device credentials. Does not register HKCU Run or use a personal profile.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

assert.equal(process.platform, "win32", "Windows acceptance required");
const install = process.argv[2];
assert.ok(install, "installed package path required");
const exe = join(install, "bin", "tetherplane-modelw.exe");
const stdioAgent = join(install, "bin", "tetherd.exe");
const config = join(install, "config", "model-worker-args.json");
const temp = await mkdtemp(join(tmpdir(), "tp-modelw-disposable-"));
let child;
let workerPid;
const noConsole = (pid) => {
  const ps = "$p=Get-Process -Id " + pid +
    " -ErrorAction Stop; if($p.MainWindowHandle -eq [IntPtr]::Zero){'NONE'}else{'VISIBLE'}";
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    windowsHide: true, encoding: "utf8", timeout: 8000,
  });
  return result.trim() === "NONE";
};
const childPids = (pid) => {
  const ps = '$p=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=' +
    pid + ' AND Name=\'node.exe\'" -ErrorAction SilentlyContinue);' +
    " @($p|ForEach-Object {$_.ProcessId}) -join ','";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    windowsHide: true, encoding: "utf8", timeout: 8000,
  }).trim().split(",").filter(Boolean).map(Number);
};

try {
  // Reject absent JSON without accidentally creating state or credentials.
  child = spawn(exe, ["--arguments-file", join(temp, "missing.json")], {
    windowsHide: false, stdio: "ignore",
  });
  const refused = await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    sleep(5000).then(() => "timeout"),
  ]);
  if (refused === "timeout") child.kill();
  assert.notEqual(refused, "timeout");
  assert.notEqual(refused, 0, "missing model arguments must fail closed");

  await mkdir(join(temp, "state"));
  const profile = join(temp, "nonproduction-profile.json");
  await writeFile(profile, '{"synthetic":true}\n');
  const args = [
    "--device", "CI-Only-" + randomBytes(4).toString("hex"),
    "--model-endpoint", "http://127.0.0.1:65534/v1",
    "--model", "ci-synthetic",
    "--tetherd", stdioAgent,
    "--principal-profile", profile,
    "--state-dir", join(temp, "state"),
    "--poll-ms", "1000",
    "--max-actions", "1",
    "--lease-ttl-ms", "1000",
  ];
  await writeFile(config, JSON.stringify(args) + "\n");
  child = spawn(exe, ["--arguments-file", config], {
    windowsHide: false, stdio: "ignore",
  });
  assert.ok(child.pid > 0);
  let pids = [];
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("native model worker launcher exited");
    pids = childPids(child.pid);
    if (pids.length > 0) break;
    await sleep(150);
  }
  assert.equal(pids.length, 1, "expected one Node worker owned by the native launcher");
  workerPid = pids[0];
  assert.ok(noConsole(child.pid), "native model launcher is visible");
  assert.ok(noConsole(workerPid), "Node model worker opened a console");
  child.kill();

  // The worker has a bounded native-parent liveness check.
  const cleanupDeadline = Date.now() + 8000;
  let gone = false;
  while (Date.now() < cleanupDeadline) {
    try {
      process.kill(workerPid, 0);
    } catch {
      gone = true;
      break;
    }
    await sleep(150);
  }
  assert.ok(gone, "model worker remained orphaned after launcher termination");
  console.log("WINDOWS_MODELW_MISSING_ARGS_DENIED_OK");
  console.log("WINDOWS_MODELW_NO_CONSOLE_CHILD_OK");
  console.log("WINDOWS_MODELW_PARENT_EXIT_NO_ORPHAN_OK");
} finally {
  if (child?.exitCode === null) child.kill();
  if (workerPid) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(workerPid), "/F"], {
        windowsHide: true, stdio: "ignore", timeout: 8000,
      });
    } catch {}
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
