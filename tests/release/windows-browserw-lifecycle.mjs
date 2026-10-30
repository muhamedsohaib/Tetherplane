// Disposable Windows package-only acceptance of the native owner-browser
// launcher. No real browser profile, pairing, HKCU autoruns or device identity.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer, connect } from "node:net";

assert.equal(process.platform, "win32", "Windows launcher test must run on Windows");
const install = process.argv[2];
assert.ok(install, "installed package path required");
const launcher = join(install, "bin", "tetherplane-browserw.exe");
const temp = await mkdtemp(join(tmpdir(), "tp-browserw-disposable-"));
const state = join(temp, "Tetherplane");
const tokenA = randomBytes(32).toString("hex");
const tokenB = randomBytes(32).toString("hex");
let supervisor;
let ownedNodePid;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function listening(port) {
  return await new Promise(resolve => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function until(condition, deadlineMs, message) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(100);
  }
  throw new Error(message);
}

function ownedNode(parentPid) {
  const command = `$p=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid} AND Name='node.exe'" -ErrorAction SilentlyContinue); @($p | ForEach-Object {$_.ProcessId}) -join ','`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8", windowsHide: true, timeout: 6000,
    }).trim();
    const pids = output.split(",").filter(Boolean).map(Number);
    assert.ok(pids.every(Number.isSafeInteger));
    return pids;
  } catch (error) {
    throw new Error("Unable to identify disposable browser child", { cause: error });
  }
}

function noVisibleWindow(pid) {
  const cmd = `$p=Get-Process -Id ${pid} -ErrorAction Stop; if($p.MainWindowHandle -eq [IntPtr]::Zero){'NONE'} else {'VISIBLE'}`;
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    encoding: "utf8", windowsHide: true, timeout: 6000,
  }).trim() === "NONE";
}

const ports = [];
while (ports.length < 3) {
  const candidate = await freePort();
  if (!ports.includes(candidate)) ports.push(candidate);
}
const [wsPort, pairingPort, rpcPort] = ports;
const env = {
  ...process.env,
  LOCALAPPDATA: temp,
  TETHERPLANE_EXTENSION_WS_PORT: String(wsPort),
  TETHERPLANE_EXTENSION_PAIRING_PORT: String(pairingPort),
  TETHERPLANE_AUTH_BROWSER_RPC_PORT: String(rpcPort),
};

try {
  // No unapproved browser can be activated by missing owner enrollment.
  let missing = spawn(launcher, ["--browser-state-dir", state], {
    env, windowsHide: false, stdio: "ignore",
  });
  const firstExit = await Promise.race([
    new Promise(resolve => missing.once("exit", resolve)),
    sleep(5000).then(() => "timeout"),
  ]);
  if (firstExit === "timeout") missing.kill();
  assert.notEqual(firstExit, "timeout", "unenrolled owner browser launcher hung");
  assert.notEqual(firstExit, 0, "unenrolled browser launcher must fail closed");
  assert.equal(await listening(wsPort), false);
  assert.equal(await listening(pairingPort), false);

  await mkdir(state);
  await writeFile(join(state, "browser-bridge.token"), tokenA + "\n");
  await writeFile(join(state, "browser-extension-launch.token"), tokenB + "\n");
  await writeFile(join(state, "browser-extension.id"), "abcdefghijklmnopabcdefghijklmnop\n");

  supervisor = spawn(launcher, ["--browser-state-dir", state], {
    cwd: install, env, windowsHide: false, stdio: "ignore",
  });
  assert.ok(Number.isSafeInteger(supervisor.pid) && supervisor.pid > 0);
  await until(async () => {
    if (supervisor.exitCode !== null) throw new Error("windowless browser supervisor exited early");
    return (await listening(wsPort)) && (await listening(pairingPort));
  }, 15000, "windowless browser host did not start");
  assert.equal(await listening(rpcPort), false, "unpaired browser RPC opened without human approval");
  assert.equal(noVisibleWindow(supervisor.pid), true, "browser supervisor opened a foreground window");
  const pids = ownedNode(supervisor.pid);
  assert.equal(pids.length, 1, "expected exactly one owned Node browser host");
  ownedNodePid = pids[0];
  assert.equal(noVisibleWindow(ownedNodePid), true, "browser child opened a foreground console");

  // The browser host must notice if its native parent disappears, so a
  // user-session shutdown cannot strand an unattached browser companion.
  supervisor.kill();
  await until(async () => !(await listening(wsPort)) && !(await listening(pairingPort)),
    8000, "orphan browser host retained pairing ports after launcher termination");
  const stdout = await readFile(join(state, "browser-host.stdout.log"), "utf8");
  const stderr = await readFile(join(state, "browser-host.stderr.log"), "utf8");
  assert.ok(!stdout.includes(tokenA) && !stdout.includes(tokenB));
  assert.ok(!stderr.includes(tokenA) && !stderr.includes(tokenB));
  assert.equal((await readFile(join(state, "browser-extension.id"), "utf8")).trim(),
    "abcdefghijklmnopabcdefghijklmnop");
  console.log("WINDOWS_BROWSERW_UNENROLLED_DENIED_OK");
  console.log("WINDOWS_BROWSERW_UNPAIRED_LOOPBACK_ONLY_OK");
  console.log("WINDOWS_BROWSERW_WINDOWLESS_PARENT_CHILD_OK");
  console.log("WINDOWS_BROWSERW_PARENT_EXIT_NO_ORPHAN_OK");
} finally {
  if (supervisor?.exitCode === null) supervisor.kill();
  if (ownedNodePid && ownedNodePid > 0) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(ownedNodePid), "/F"], {
        windowsHide: true, timeout: 5000, stdio: "ignore",
      });
    } catch { /* test-owned child has exited */ }
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
