// Acceptance against a *real* Chrome-compatible browser and the installed
// Tetherplane extension/host. Uses an isolated headless profile, synthetic
// credentials and a private loopback fixture. No human browser is touched.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const install = process.argv[2];
const edge = process.argv[3];
assert.ok(install && edge, "usage: node browser-real-extension-acceptance.mjs INSTALL EDGEPATH");
const extension = path.join(install, "browser", "extension");
const hostPath = path.join(install, "browser", "host.mjs");
await Promise.all([
  access(path.join(extension, "manifest.json")),
  access(path.join(extension, "dist", "pair.js")),
  access(hostPath),
  access(edge),
]);

const root = await mkdtemp(path.join(os.tmpdir(), "tp-browser-real-extension-"));
const profile = path.join(root, "browser-profile");
const state = path.join(root, "Tetherplane");
const fixtureHtml = '<!DOCTYPE html><html><body>' +
  '<input aria-label="Release marker" id="marker" value="before">' +
  '<button aria-label="Commit fixture action" onclick="document.querySelector(' +
  "'#marker').value='clicked'\"" + '>Commit fixture action</button>' +
  '</body></html>';
const result = {
  temporaryProfile: true,
  actualExtensionLoaded: false,
  pinnedLocalPairing: false,
  hostAuthenticatedExtension: false,
  browserRpcAuthenticated: false,
  realOwnedTabCreated: false,
  verifiedBrowserAction: false,
  humanTabDenied: false,
  tokenRedacted: false,
  cleaned: false,
  verdict: "FAIL",
};
let browser = null;
let host = null;
let fixture = null;
let port = null;
let ws = null;
const seen = [];
const errors = [];
const token = randomBytes(32).toString("hex");
const launchToken = randomBytes(32).toString("hex");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(label + ": " + String(last?.message ?? "timeout"));
}
async function availablePort() {
  const s = createTcpServer();
  await new Promise((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", resolve);
  });
  const p = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return p;
}
async function rpc(portNumber, capability, args = {}) {
  const request = capability === "handshake"
    ? {type: "handshake", request_id: "release-handshake", token}
    : {type: "invoke", request_id: "release-" + capability, token,
      capability: "browser." + capability, arguments: args};
  const reply = new Promise((resolve, reject) => {
    const client = connect({host: "127.0.0.1", port: portNumber});
    let buffer = "";
    client.setTimeout(5000, () => client.destroy(new Error("browser RPC timed out")));
    client.once("connect", () => client.write(JSON.stringify(request) + "\n"));
    client.on("data", bytes => { buffer += bytes.toString("utf8"); });
    client.once("error", reject);
    client.once("end", () => {
      try { resolve(JSON.parse(buffer.trim())); } catch (error) { reject(error); }
    });
  });
  return await Promise.race([reply, delay(6000).then(() => { throw new Error("browser RPC deadline"); })]);
}
async function evaluatePage(endpoint, expression) {
  const socket = new WebSocket(endpoint);
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, {once: true});
      socket.addEventListener("error", reject, {once: true});
    }),
    delay(5000).then(() => { throw new Error("CDP websocket did not open"); }),
  ]);
  try {
    const response = new Promise((resolve, reject) => {
      socket.addEventListener("message", event => {
        try {
          const body = JSON.parse(String(event.data));
          if (body.id === 1) {
            if (body.error) reject(new Error(body.error.message));
            else resolve(body.result);
          }
        } catch (error) { reject(error); }
      });
    });
    socket.send(JSON.stringify({id: 1, method: "Runtime.evaluate",
      params: {expression, returnByValue: true}}));
    return await Promise.race([response, delay(6000).then(() => {throw new Error("CDP evaluation timeout");})]);
  } finally { socket.close(); }
}
async function stopOwnedBrowser() {
  if (browser && browser.exitCode === null) browser.kill();
  // Restrict further termination to msedge.exe processes whose command
  // line contains this uniquely generated, test-owned profile directory.
  const escapedProfile = profile.replaceAll("'", "''");
  const command = "$p='" + escapedProfile + "'; " +
    "Get-CimInstance Win32_Process -Filter \"Name = 'msedge.exe'\" " +
    "| Where-Object {([string]$_.CommandLine).Contains($p)} " +
    "| ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}";
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    {stdio: "ignore", windowsHide: true, timeout: 10000});
}

try {
  await mkdir(profile, {recursive: true});
  await mkdir(state, {recursive: true});

  fixture = createHttpServer((_request, response) => {
    response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
    response.end(fixtureHtml);
  });
  await new Promise((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  });
  const fixtureUrl = "http://127.0.0.1:" + fixture.address().port + "/";

  browser = spawn(edge, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-default-apps", "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
    "--disable-extensions-except=" + extension,
    "--load-extension=" + extension,
    "about:blank",
  ], {windowsHide: true, stdio: "ignore"});

  const portFile = path.join(profile, "DevToolsActivePort");
  port = await until(async () => {
    const value = await readFile(portFile, "utf8");
    const p = Number(value.trim().split(/\r?\n/)[0]);
    return Number.isSafeInteger(p) && p > 0 ? p : null;
  }, 15000, "isolated browser DevTools unavailable");

  const extensionTarget = await until(async () => {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list");
    const targets = await response.json();
    return targets.find(x => /^chrome-extension:\/\/[a-p]{32}\//.test(x.url));
  }, 15000, "actual extension service worker missing");
  const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(extensionTarget.url)?.[1];
  assert.match(id, /^[a-p]{32}$/);
  result.actualExtensionLoaded = true;

  const wsPort = await availablePort();
  const pairPort = await availablePort();
  const rpcPort = await availablePort();
  assert.equal(new Set([wsPort, pairPort, rpcPort]).size, 3);

  await writeFile(path.join(state, "browser-bridge.token"), token + "\n", {mode: 0o600});
  await writeFile(path.join(state, "browser-extension-launch.token"), launchToken + "\n", {mode: 0o600});
  await writeFile(path.join(state, "browser-extension.id"), id + "\n", {mode: 0o600});
  host = spawn(process.execPath, [hostPath], {
    cwd: path.dirname(hostPath),
    windowsHide: true,
    env: {
      ...process.env,
      LOCALAPPDATA: root,
      TETHERPLANE_BROWSER_BRIDGE_TOKEN_FILE: path.join(state, "browser-bridge.token"),
      TETHERPLANE_EXTENSION_LAUNCH_TOKEN_FILE: path.join(state, "browser-extension-launch.token"),
      TETHERPLANE_EXTENSION_ID_FILE: path.join(state, "browser-extension.id"),
      TETHERPLANE_EXTENSION_WS_PORT: String(wsPort),
      TETHERPLANE_EXTENSION_PAIRING_PORT: String(pairPort),
      TETHERPLANE_AUTH_BROWSER_RPC_PORT: String(rpcPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const reader = createInterface({input: host.stdout, crlfDelay: Infinity});
  reader.on("line", line => seen.push(line.slice(0, 180)));
  host.stderr.on("data", bytes => errors.push(bytes.toString().slice(0, 180)));
  await until(() => seen.some(x => x.startsWith("AUTH_PAIRING_READY=")),
    10000, "host pairing endpoint did not start");

  const popupUrl = "chrome-extension://" + id + "/pair.html";
  const opened = await fetch("http://127.0.0.1:" + port +
    "/json/new?" + encodeURIComponent(popupUrl), {method: "PUT"});
  assert.equal(opened.status, 200, "cannot open extension pairing page");
  const popup = await opened.json();
  assert.equal(popup.url, popupUrl);

  await until(async () => {
    const response = await evaluatePage(popup.webSocketDebuggerUrl,
      "document.querySelector('#pair-local') !== null");
    return response.result?.value === true;
  }, 10000, "extension popup never loaded its pairing control");

  const clicked = await evaluatePage(popup.webSocketDebuggerUrl,
    "document.querySelector('#pair-local').click(); true");
  assert.equal(clicked.result?.value, true);

  await until(() => seen.some(x => x.startsWith("AUTH_EXTENSION_CONNECTED=")),
    10000, "real Chrome extension did not authenticate to host");
  result.hostAuthenticatedExtension = true;
  await until(() => seen.some(x => x.startsWith("AUTH_BROWSER_RPC_READY=")),
    10000, "browser RPC did not become ready after extension pairing");
  result.pinnedLocalPairing = true;

  const handshake = await rpc(rpcPort, "handshake");
  assert.equal(handshake.status, "success");
  assert.ok(handshake.data.operations.includes("create_tab"));
  result.browserRpcAuthenticated = true;

  const created = await rpc(rpcPort, "create_tab", {url: fixtureUrl});
  assert.equal(created.status, "success", JSON.stringify(created.error));
  const pageId = created.data.page_id;
  assert.equal(created.data.ownership, "tetherplane");
  assert.equal(created.data.active, false);
  result.realOwnedTabCreated = true;

  const snapshot = await until(async () => {
    const current = await rpc(rpcPort, "snapshot", {page_id: pageId});
    if (current.status !== "success") return null;
    const input = current.data.nodes?.find(x => x.accessible_name === "Release marker");
    const button = current.data.nodes?.find(x => x.accessible_name === "Commit fixture action");
    return input && button ? {input, button} : null;
  }, 12000, "owned tab did not expose semantic nodes");

  const action = await rpc(rpcPort, "act", {
    page_id: pageId, actions: [{kind: "click", target: snapshot.button.ref}],
    expectations: [{kind: "value", target: snapshot.input.ref, equals: "clicked"}],
    timeout_ms: 5000,
  });
  assert.equal(action.status, "success", JSON.stringify(action.error));
  assert.equal(action.data.state, "verified", JSON.stringify(action.data));
  result.verifiedBrowserAction = true;

  const pages = await rpc(rpcPort, "pages");
  const humanPage = pages.data?.pages?.find(p =>
    p.ownership === "human" && p.url.startsWith("chrome-extension://"));
  assert.ok(humanPage, "expected unshared extension popup to be human-owned");
  const forbidden = await rpc(rpcPort, "snapshot", {page_id: humanPage.page_id});
  assert.equal(forbidden.status, "error");
  assert.equal(forbidden.error.code, "permission_denied");
  result.humanTabDenied = true;

  const closed = await rpc(rpcPort, "close", {page_id: pageId});
  assert.equal(closed.status, "success");
  result.tokenRedacted = ![...seen, ...errors].some(x =>
    x.includes(token) || x.includes(launchToken));
} catch (error) {
  result.error = String(error?.message ?? error).slice(0, 260);
} finally {
  if (ws) ws.close();
  if (host) {
    if (host.exitCode === null) host.kill();
    await delay(350);
  }
  try { await stopOwnedBrowser(); } catch { result.error ??= "test browser cleanup failed"; }
  if (fixture) {
    await new Promise(resolve => fixture.close(resolve));
  }
  await delay(1200);
  try {
    await rm(root, {recursive: true, force: true, maxRetries: 15, retryDelay: 200});
    result.cleaned = true;
  } catch { result.error ??= "test-owned profile could not be removed"; }
}

if (result.cleaned && result.actualExtensionLoaded && result.hostAuthenticatedExtension &&
    result.pinnedLocalPairing && result.browserRpcAuthenticated && result.realOwnedTabCreated &&
    result.verifiedBrowserAction && result.humanTabDenied && result.tokenRedacted &&
    !result.error) result.verdict = "PASS";
console.log("REAL_EXTENSION_ACCEPTANCE=" + JSON.stringify(result));
if (result.verdict !== "PASS") process.exitCode = 1;
