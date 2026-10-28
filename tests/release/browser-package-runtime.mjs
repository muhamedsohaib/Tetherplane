// Verify the *installed* browser host, not the source checkout or a TS mock.
// Only synthetic credentials, random loopback ports, and a temporary
// LOCALAPPDATA tree. Never loads a human browser profile or pairs a browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { createServer, connect } from "node:net";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const install = process.argv[2];
assert.ok(install, "installed prefix argument is required");
const host = path.join(install, "browser", "host.mjs");
await access(host);
const root = await mkdtemp(path.join(os.tmpdir(), "tetherplane-browser-release-"));
const browserRoot = path.join(root, "Tetherplane");
const bridgeSecretFile = path.join(browserRoot, "browser-bridge.token");
const launchSecretFile = path.join(browserRoot, "browser-extension-launch.token");
const extensionIdFile = path.join(browserRoot, "browser-extension.id");
const bridgeSecret = randomBytes(32).toString("hex");
const launchSecret = randomBytes(32).toString("hex");
const results = {
  missingTokenFailsClosed: false,
  bundledHostStarts: false,
  extensionWsLoopbackOnly: false,
  pairingLoopbackOnly: false,
  webOriginDeniedPairing: false,
  pairingSecretNotDisclosed: false,
  browserRpcUnavailableBeforePairing: false,
  hostExited: false,
  tempStateRemoved: false,
  verdict: "FAIL",
};
let child;
const timeout = (ms) => new Promise((_, reject) =>
  setTimeout(() => reject(new Error("RELEASE_HOST_TIMEOUT")), ms));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function spawnHost(env) {
  return spawn(process.execPath, [host], {
    cwd: path.dirname(host),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function isPortAccepting(port) {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(900, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
async function killOnlyOwnedProcess(proc) {
  if (!proc) return;
  if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  await Promise.race([
    new Promise(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) resolve();
      else proc.once("exit", resolve);
    }),
    sleep(5000),
  ]);
  if (proc.exitCode === null && proc.signalCode === null)
    throw new Error("TEST_OWNED_HOST_DID_NOT_TERMINATE");
}
const baseEnv = {
  ...process.env,
  LOCALAPPDATA: root,
  TETHERPLANE_BROWSER_BRIDGE_TOKEN_FILE: bridgeSecretFile,
  TETHERPLANE_EXTENSION_LAUNCH_TOKEN_FILE: launchSecretFile,
  TETHERPLANE_EXTENSION_ID_FILE: extensionIdFile,
};
try {
  // A new install has no locally issued credentials. It must not expose
  // any browser control or silently generate them for an unapproved caller.
  const withoutTokens = spawnHost(baseEnv);
  let invalidOutput = "";
  withoutTokens.stdout.on("data", chunk => { invalidOutput += chunk.toString().slice(0, 500); });
  const invalidExit = await Promise.race([
    new Promise(resolve => withoutTokens.once("exit", (code) => resolve(code))),
    timeout(7000),
  ]);
  assert.notEqual(invalidExit, 0, "host must refuse missing owner token files");
  assert.doesNotMatch(invalidOutput, /AUTH_PAIRING_READY|AUTH_BROWSER_RPC_READY|AUTH_EXTENSION_WS_READY/);
  results.missingTokenFailsClosed = true;

  await mkdir(browserRoot, { recursive: true });
  await writeFile(bridgeSecretFile, bridgeSecret + "\n", { mode: 0o600 });
  await writeFile(launchSecretFile, launchSecret + "\n", { mode: 0o600 });
  const [wsPort, pairingPort, rpcPort] =
    await Promise.all([availablePort(), availablePort(), availablePort()]);
  assert.equal(new Set([wsPort, pairingPort, rpcPort]).size, 3, "distinct loopback ports");
  child = spawnHost({
    ...baseEnv,
    TETHERPLANE_EXTENSION_WS_PORT: String(wsPort),
    TETHERPLANE_EXTENSION_PAIRING_PORT: String(pairingPort),
    TETHERPLANE_AUTH_BROWSER_RPC_PORT: String(rpcPort),
  });
  const markers = new Set();
  const stdoutLines = [];
  let secretInOutput = false;
  let stderrNonempty = false;
  child.stderr.on("data", chunk => {
    stderrNonempty ||= chunk.toString().trim().length > 0;
    secretInOutput ||= chunk.toString().includes(bridgeSecret) ||
      chunk.toString().includes(launchSecret);
  });
  const ready = new Promise((resolve, reject) => {
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on("line", line => {
      stdoutLines.push(line.slice(0, 300));
      secretInOutput ||= line.includes(bridgeSecret) || line.includes(launchSecret);
      if (line.startsWith("AUTH_EXTENSION_WS_READY=")) markers.add("WS");
      if (line.startsWith("AUTH_PAIRING_READY=")) markers.add("PAIRING");
      if (markers.size === 2) resolve();
    });
    child.once("exit", (code) =>
      reject(new Error("INSTALLED_HOST_EARLY_EXIT_" + String(code))));
  });
  await Promise.race([ready, timeout(12000)]);
  results.bundledHostStarts = true;
  assert.ok(stdoutLines.some(line => line ===
    "AUTH_EXTENSION_WS_READY=ws://127.0.0.1:" + wsPort));
  results.extensionWsLoopbackOnly = true;
  assert.ok(stdoutLines.some(line => line ===
    "AUTH_PAIRING_READY=http://127.0.0.1:" + pairingPort + "/pair"));
  results.pairingLoopbackOnly = true;
  assert.equal(secretInOutput, false, "host must never write raw token values");

  const response = await Promise.race([
    fetch("http://127.0.0.1:" + pairingPort + "/pair", {
      method: "POST",
      headers: {
        origin: "https://untrusted.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        extension_id: "abcdefghijklmnopabcdefghijklmnop",
      }),
    }),
    timeout(4000),
  ]);
  assert.equal(response.status, 403);
  const body = await response.text();
  assert.doesNotMatch(body, new RegExp(bridgeSecret + "|" + launchSecret));
  results.webOriginDeniedPairing = true;
  results.pairingSecretNotDisclosed = true;
  assert.equal(await isPortAccepting(rpcPort), false,
    "browser RPC must not start before an authenticated extension is paired");
  results.browserRpcUnavailableBeforePairing = true;

  await killOnlyOwnedProcess(child);
  results.hostExited = true;
  assert.equal(await isPortAccepting(wsPort), false,
    "test-owned browser bridge listener survived process shutdown");
  assert.equal(await isPortAccepting(pairingPort), false,
    "test-owned pairing listener survived process shutdown");
  assert.equal(stderrNonempty, false,
    "running the installed browser host emitted unexpected stderr");
  results.verdict = "PASS_PENDING_CLEANUP";
} catch (error) {
  results.error = String(error?.message ?? error).slice(0, 180);
} finally {
  try { await killOnlyOwnedProcess(child); }
  catch { results.error = "TEST_BROWSER_HOST_CLEANUP_FAILED"; }
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    results.tempStateRemoved = true;
  } catch { results.error = "TEST_STATE_CLEANUP_FAILED"; }
}
if (results.verdict === "PASS_PENDING_CLEANUP" && results.tempStateRemoved) {
  results.verdict = "PASS";
} else {
  results.verdict = "FAIL";
}
console.log("BROWSER_PACKAGE_RUNTIME=" + JSON.stringify(results));
if (results.verdict !== "PASS") process.exitCode = 1;
