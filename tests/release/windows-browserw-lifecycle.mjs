// Disposable Windows package-only acceptance of the native owner-browser
// launcher. No real browser profile, pairing, HKCU autoruns or device identity.
import assert from "node:assert/strict";
import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
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

// A cold Windows CI runner can take longer than six seconds to initialize
// CIM/Windows PowerShell. Query only the disposable parent/child once,
// asynchronously, with a bounded retry. A missing or ambiguous child still
// fails the release gate; this is not a test skip or security exception.
const execFileAsync = promisify(execFile);
async function inspectWindowlessBrowserChild(parentPid) {
  const command = [
    "$ErrorActionPreference='Stop'",
    `$children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid} AND Name='node.exe'" -ErrorAction Stop)`,
    `$parent=Get-Process -Id ${parentPid} -ErrorAction Stop`,
    "$childProcesses=@($children | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction Stop })",
    "[pscustomobject]@{childPids=@($children | ForEach-Object { [int]$_.ProcessId });parentWindowless=($parent.MainWindowHandle -eq [IntPtr]::Zero);childWindowless=@($childProcesses | ForEach-Object { $_.MainWindowHandle -eq [IntPtr]::Zero })} | ConvertTo-Json -Compress -Depth 3",
  ].join("; ");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const {stdout} = await execFileAsync("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        {encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 32768});
      const inspection = JSON.parse(stdout.trim());
      assert.ok(Array.isArray(inspection.childPids), "child PID evidence must be an array");
      assert.ok(inspection.childPids.every(Number.isSafeInteger), "invalid child PID evidence");
      assert.equal(typeof inspection.parentWindowless, "boolean", "parent visibility missing");
      assert.ok(Array.isArray(inspection.childWindowless), "child visibility evidence missing");
      assert.equal(inspection.childWindowless.length, inspection.childPids.length,
        "child visibility evidence is incomplete");
      assert.ok(inspection.childWindowless.every(v => typeof v === "boolean"));
      return inspection;
    } catch (error) {
      if (attempt === 2) {
        throw new Error("Unable to inspect the disposable browser parent/child", {cause: error});
      }
      await sleep(250);
    }
  }
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
  const inspection = await inspectWindowlessBrowserChild(supervisor.pid);
  assert.equal(inspection.parentWindowless, true, "browser supervisor opened a foreground window");
  assert.equal(inspection.childPids.length, 1, "expected exactly one owned Node browser host");
  ownedNodePid = inspection.childPids[0];
  assert.deepEqual(inspection.childWindowless, [true], "browser child opened a foreground console");

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
