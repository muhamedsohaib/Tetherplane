// Windows CI only: disposable owner-state, no MSIX install, no registration,
// no Store account, no OAuth, no real relay. This does NOT certify interactive
// Windows 11 Smart App Control behavior or Windows Startup setting activation.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { initializeCredentialDirectory, assertPrivateCredentialState } from
  "../../packaging/msix-store-runtime/app/state-security.mjs";

assert.equal(process.platform, "win32", "Test requires disposable Windows runner");
assert.equal(process.argv.length, 4, "Two exact compiled binary paths required");
const root = await mkdtemp(join(tmpdir(), "tp-store-logon-test-"));
const packageRoot = join(root, "package");
const ownerState = join(root, "TetherplaneStore");
const launcher = join(packageRoot, "bin", "tetherplane-autostartw.exe");
const agentExe = join(packageRoot, "bin", "tetherd-agentw.exe");
const runner = join(packageRoot, "app", "agent-autostart.mjs");
const startEnv = { ...process.env, LOCALAPPDATA: root };
let first, duplicate, nodePid, agentPid;

function ps(command) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true, encoding: "utf8", timeout: 7000
  }).trim();
}
function children(parent, name) {
  assert.ok(Number.isSafeInteger(parent) && parent > 0);
  assert.match(name, /^[a-z0-9.-]+$/i);
  const command = '$p=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=' +
    parent + ' AND Name=' + "'" + name + "'" + '" -ErrorAction SilentlyContinue);' +
    ' @($p|ForEach-Object {$_.ProcessId}) -join ","';
  return ps(command).split(",").filter(Boolean).map(Number);
}
function noMainWindow(pid) {
  const result = ps("$p=Get-Process -Id " + pid +
    " -ErrorAction Stop; if($p.MainWindowHandle -eq [IntPtr]::Zero){'NONE'}else{'VISIBLE'}");
  return result === "NONE";
}
async function waitUntil(check, timeout, message) {
  const stop = Date.now() + timeout;
  while (Date.now() < stop) {
    if (await check()) return;
    await sleep(150);
  }
  throw Error(message);
}
function launch() {
  return spawn(launcher, [], {
    cwd: packageRoot, env: startEnv, windowsHide: false, stdio: "ignore"
  });
}
async function exitWithin(child, timeout) {
  if (child.exitCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise(resolveExit => child.once("exit", resolveExit)),
    sleep(timeout).then(() => "TIMEOUT")
  ]);
}
async function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

try {
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await mkdir(join(packageRoot, "runtime"));
  await mkdir(join(packageRoot, "app"));
  await copyFile(resolve(process.argv[2]), launcher);
  await copyFile(resolve(process.argv[3]), agentExe);
  await copyFile(process.execPath, join(packageRoot, "runtime", "node.exe"));
  for (const name of ["agent-autostart.mjs", "runtime-app.mjs", "state-security.mjs"]) {
    await copyFile(resolve("packaging", "msix-store-runtime", "app", name),
      join(packageRoot, "app", name));
  }

  // The startup task can be toggled before owner approval in Windows Settings.
  // It must NOT generate a device identity, credential or active agent.
  let denied = launch();
  assert.equal(await exitWithin(denied, 9000), 0,
    "no paired state must be inert, not a prompting setup window");
  assert.equal(children(denied.pid, "node.exe").length, 0);
  assert.equal(children(denied.pid, "tetherd-agentw.exe").length, 0);
  console.log("STORE_LOGON_UNPAIRED_NO_AGENT_PASS");

  // Untrusted existing state must not be adopted or silently re-permissioned.
  await mkdir(ownerState);
  await writeFile(join(ownerState, "device.json"), "{}");
  await writeFile(join(ownerState, "device-credential.txt"), "not-owner-approved");
  denied = launch();
  assert.notEqual(await exitWithin(denied, 10000), 0,
    "invalid existing owner identity must fail closed");
  await rm(ownerState, { recursive: true, force: true });

  // Synthetic LOCAL owner state: the exact Windows ACL routine from onboarding
  // applies; test-only secret is never sent to a live relay or another device.
  await initializeCredentialDirectory(ownerState);
  const allowed = join(root, "allowed");
  await mkdir(allowed);
  const configuration = {
    version: 1,
    deviceId: "ci-store-owner-" + randomBytes(4).toString("hex"),
    relayUrl: "wss://127.0.0.1:65431/device",
    allowRoot: allowed
  };
  await writeFile(join(ownerState, "device-credential.txt"),
    randomBytes(48).toString("base64url") + "\n", { flag: "wx" });
  await writeFile(join(ownerState, "device.json"),
    JSON.stringify(configuration) + "\n", { flag: "wx" });
  await assertPrivateCredentialState(ownerState);
  first = launch();
  await waitUntil(async () => {
    if (first.exitCode !== null) throw Error("owner startup exited before agent launch");
    const nodes = children(first.pid, "node.exe");
    if (nodes.length !== 1) return false;
    nodePid = nodes[0];
    const agents = children(nodePid, "tetherd-agentw.exe");
    if (agents.length !== 1) return false;
    agentPid = agents[0];
    return await alive(agentPid);
  }, 18000, "owner-approved startup did not create one native agent");
  assert.equal(noMainWindow(first.pid), true, "startup GUI launcher opened a window");
  assert.equal(noMainWindow(nodePid), true, "signed Node child opened a console");
  assert.equal(noMainWindow(agentPid), true, "background agent opened a console");
  console.log("STORE_LOGON_APPROVED_WINDOWLESS_AGENT_PASS");

  // Opening the wizard after login must not create another live agent. The
  // same exclusive Windows file lock is passed to both startup and setup.
  duplicate = launch();
  assert.equal(await exitWithin(duplicate, 14000), 0,
    "duplicate should yield gracefully to already-running approved agent");
  assert.equal(await alive(agentPid), true, "first approved agent must remain");
  assert.equal(children(nodePid, "tetherd-agentw.exe").length, 1);
  console.log("STORE_LOGON_SECOND_AGENT_DENIED_PASS");

  // A dead Store startup launcher must not strand its Node or native agent.
  first.kill();
  await waitUntil(async () =>
    !(await alive(nodePid)) && !(await alive(agentPid)),
    10000, "startup parent termination left a Node or agent orphan");
  console.log("STORE_LOGON_PARENT_TERMINATION_NO_ORPHAN_PASS");
} finally {
  for (const child of [duplicate, first]) {
    if (child?.exitCode === null) child.kill();
  }
  for (const pid of [agentPid, nodePid]) {
    if (!pid || !(await alive(pid))) continue;
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/F"], {
        windowsHide: true, stdio: "ignore", timeout: 5000
      });
    } catch { /* test-owned child already exited */ }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 125 });
}
