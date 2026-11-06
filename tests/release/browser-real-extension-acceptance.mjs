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
  extensionInstalledViaCdp: false,
  pinnedLocalPairing: false,
  oneClickOwnerPopupConnected: false,
  oneClickInitialPairing: false,
  repeatedAuthorizedReads: false,
  hostAuthenticatedExtension: false,
  browserRpcAuthenticated: false,
  realOwnedTabCreated: false,
  unapprovedOwnedCreationDenied: false,
  ownedSiteGrantedLocally: false,
  ownedSiteRevocationDenied: false,
  verifiedBrowserAction: false,
  humanTabDenied: false,
  sharedOriginPinned: false,
  crossOriginNavigationDenied: false,
  redirectRevoked: false,
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
      params: {expression, returnByValue: true, awaitPromise: true}}));
    return await Promise.race([response, delay(6000).then(() => {throw new Error("CDP evaluation timeout");})]);
  } finally { socket.close(); }
}
// Branded Chrome/Edge no longer honor --load-extension. In a disposable
// debug profile, request explicit unpacked installation over browser CDP.
// Never connect to, or change, an existing owner browser session.
async function browserCdp(endpoint, method, params) {
  const socket = new WebSocket(endpoint);
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, {once: true});
        socket.addEventListener("error", () =>
          reject(new Error("isolated Edge CDP browser socket failed")), {once: true});
      }),
      delay(5000).then(() => { throw new Error("isolated Edge CDP browser socket deadline"); }),
    ]);
    const response = new Promise((resolve, reject) => {
      socket.addEventListener("message", event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.id !== 7) return;
        if (message.error) {
          reject(new Error("isolated Edge CDP " + method + " unavailable: " +
            String(message.error.code ?? "unknown") + " " +
            String(message.error.message ?? "").slice(0, 100)));
        } else {
          resolve(message.result);
        }
      });
    });
    socket.send(JSON.stringify({id: 7, method, params}));
    return await Promise.race([
      response,
      delay(6000).then(() => { throw new Error("isolated Edge CDP command deadline"); }),
    ]);
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
    "about:blank",
  ], {windowsHide: true, stdio: "ignore"});

  const portFile = path.join(profile, "DevToolsActivePort");
  port = await until(async () => {
    const value = await readFile(portFile, "utf8");
    const p = Number(value.trim().split(/\r?\n/)[0]);
    return Number.isSafeInteger(p) && p > 0 ? p : null;
  }, 15000, "isolated browser DevTools unavailable");

  // The command-line --load-extension/--disable-extensions-except flags
  // are no longer supported by branded Edge. Install only into this newly
  // created, test-owned profile using browser-level DevTools.
  const browserInfo = await until(async () => {
    const response = await fetch("http://127.0.0.1:" + port + "/json/version");
    const data = await response.json();
    return typeof data.webSocketDebuggerUrl === "string" ? data : null;
  }, 5000, "isolated Edge browser CDP endpoint unavailable");
  const installResponse = await browserCdp(
    browserInfo.webSocketDebuggerUrl, "Extensions.loadUnpacked", {path: extension});
  const installedExtensionId = installResponse?.id;
  assert.match(installedExtensionId, /^[a-p]{32}$/,
    "isolated Edge did not install the reviewed unpacked extension");
  result.extensionInstalledViaCdp = true;

  // Edge ships first-party extensions such as Microsoft Voices. Never take
  // the first chrome-extension target: bind to the actual Tetherplane manifest.
  const extensionTarget = await until(async () => {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list");
    const targets = await response.json();
    for (const candidate of targets) {
      const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(candidate.url);
      if (!match || match[1] !== installedExtensionId ||
          !candidate.webSocketDebuggerUrl) continue;
      try {
        const identity = await evaluatePage(candidate.webSocketDebuggerUrl,
          "({name:chrome.runtime.getManifest().name,id:chrome.runtime.id})");
        if (identity.result?.value?.name === "Tetherplane Browser Bridge" &&
            identity.result?.value?.id === match[1]) {
          return { ...candidate, extension_id: match[1] };
        }
      } catch {
        // Ignore unrelated/short-lived browser-internal extension targets.
      }
    }
    return null;
  }, 15000, "CDP-installed Tetherplane extension service worker missing");
  const id = extensionTarget.extension_id;
  assert.match(id, /^[a-p]{32}$/);
  result.actualExtensionLoaded = true;

  let wsPort = await availablePort();
  let rpcPort = await availablePort();
  // Real operator pairing uses the fixed loopback endpoint in pair.ts.
  // This acceptance runs only on a disposable hosted Windows runner; it
  // must fail if that port is occupied rather than disturb any other host.
  const pairPort = 17656;
  while (wsPort === pairPort) wsPort = await availablePort();
  while (rpcPort === pairPort || rpcPort === wsPort) rpcPort = await availablePort();
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
  // A DevTools /json/new navigation to an extension URL can yield an
  // internal chrome-error page. Have the isolated extension create its own
  // UI page through chrome.tabs instead of simulating a foreign navigation.
  const opened = await evaluatePage(extensionTarget.webSocketDebuggerUrl,
    "chrome.tabs.create({url:chrome.runtime.getURL('pair.html'),active:false}).then(tab=>({id:tab.id,url:tab.url}))");
  assert.ok(Number.isSafeInteger(opened.result?.value?.id),
    "extension could not create its own pairing tab");
  const popup = await until(async () => {
    const response = await fetch("http://127.0.0.1:" + port + "/json/list");
    const targets = await response.json();
    const target = targets.find(x => x.url === popupUrl && x.type === "page");
    return target?.webSocketDebuggerUrl ? target : null;
  }, 10000, "extension-owned pairing page did not expose a page target");

  let popupDiagnostic = null;
  try {
    await until(async () => {
      const response = await evaluatePage(popup.webSocketDebuggerUrl,
        "({href:location.href,readyState:document.readyState,title:document.title,pairFound:document.querySelector('#pair-local')!==null})");
      popupDiagnostic = response.result?.value ??
        {exception: String(response.exceptionDetails?.text ?? "no evaluation value")};
      return popupDiagnostic.pairFound === true;
    }, 10000, "extension popup never loaded its pairing control");
  } catch (error) {
    // Non-secret diagnostic only. No DOM text, credentials, cookies or tokens.
    result.popupDiagnostic = popupDiagnostic;
    throw error;
  }

  // First-run acceptance: one owner click pairs the extension AND
  // grants the currently selected website without using advanced controls.
  const firstTab = await evaluatePage(extensionTarget.webSocketDebuggerUrl,
    "chrome.tabs.create({url:" + JSON.stringify(fixtureUrl) +
    ",active:true}).then(t=>({id:t.id,active:t.active}))");
  const firstTabId = firstTab.result?.value?.id;
  assert.ok(Number.isSafeInteger(firstTabId));
  await until(async () => {
    const live = await evaluatePage(extensionTarget.webSocketDebuggerUrl,
      "chrome.tabs.get(" + firstTabId + ").then(t=>t.url)");
    return live.result?.value?.startsWith(fixtureUrl) === true;
  }, 10000, "first-run fixture tab did not load");
  const clicked = await evaluatePage(popup.webSocketDebuggerUrl,
    "(()=>{const control=document.querySelector('#quick-connect');" +
    "if(!control)return false;control.click();return true;})()");
  assert.equal(clicked.result?.value, true);

  try {
    await until(() => seen.some(x => x.startsWith("AUTH_EXTENSION_CONNECTED=")),
      10000, "real Chrome extension did not authenticate to host");
  } catch (error) {
    const ui = await evaluatePage(popup.webSocketDebuggerUrl,
      "({status:document.querySelector('#status')?.textContent||''," +
      "share:document.querySelector('#share-status')?.textContent||''," +
      "localDisabled:document.querySelector('#pair-local')?.disabled??null})");
    result.pairingPopupDiagnostics = ui.result?.value ?? {};
    result.pairingHostSteps = seen.filter(v =>
      v.startsWith("AUTH_PAIRING_READY") || v.startsWith("AUTH_EXTENSION_CONNECTED") ||
      v.startsWith("AUTH_EXTENSION_WS_READY")).map(v => v.slice(0,35));
    throw error;
  }
  result.hostAuthenticatedExtension = true;
  await until(() => seen.some(x => x.startsWith("AUTH_BROWSER_RPC_READY=")),
    10000, "browser RPC did not become ready after extension pairing");
  result.pinnedLocalPairing = true;

  const handshake = await rpc(rpcPort, "handshake");
  assert.equal(handshake.status, "success");
  assert.ok(handshake.data.operations.includes("create_tab"));
  result.browserRpcAuthenticated = true;
  await until(async () => {
    const pages = await rpc(rpcPort, "pages");
    return pages.data?.pages?.find(p =>
      p.tab_id === firstTabId && p.ownership === "shared-authorized") ?? null;
  }, 12000, "first-run one-click popup did not grant the selected tab");
  const initialPopup = await evaluatePage(popup.webSocketDebuggerUrl,
    "({status:document.querySelector('#share-status')?.textContent||''," +
    "connection:document.querySelector('#connection-state')?.textContent||''})");
  assert.match(initialPopup.result?.value?.status ?? "",
    /Current tab connected|This tab is shared/);
  result.oneClickInitialPairing = true;

  // Remote ownership must not authorize a site. Only the owner's local
  // popup can approve an exact website origin for AI-created tabs.
  const deniedOwned = await rpc(rpcPort, "create_tab", {url: fixtureUrl});
  assert.equal(deniedOwned.status, "error", "unapproved site opened an AI tab");
  assert.equal(deniedOwned.error?.code, "permission_denied");
  result.unapprovedOwnedCreationDenied = true;

  const approvalTab = await evaluatePage(extensionTarget.webSocketDebuggerUrl,
    "chrome.tabs.create({url:" + JSON.stringify(fixtureUrl) +
    ",active:false}).then(t=>({id:t.id}))");
  const approvalTabId = approvalTab.result?.value?.id;
  assert.ok(Number.isSafeInteger(approvalTabId));
  await until(async () => {
    const tab = await evaluatePage(popup.webSocketDebuggerUrl,
      "chrome.tabs.get(" + approvalTabId + ").then(t=>t.url)");
    return tab.result?.value?.startsWith(fixtureUrl) === true;
  }, 10000, "local owner site tab was not ready");
  const siteApproval = await evaluatePage(popup.webSocketDebuggerUrl,
    "chrome.runtime.sendMessage({type:'tetherplane.approve_owned_site',tab_id:" +
    approvalTabId + ",ttl_ms:300000,allow_navigate:true,allow_upload:false})");
  assert.equal(siteApproval.result?.value?.ok, true, "owner site approval rejected");
  result.ownedSiteGrantedLocally = true;

  const created = await rpc(rpcPort, "create_tab", {url: fixtureUrl});
  assert.equal(created.status, "success", JSON.stringify(created.error));
  const pageId = created.data.page_id;
  assert.equal(created.data.ownership, "tetherplane");
  assert.equal(created.data.active, false);
  result.realOwnedTabCreated = true;

  // A real installed Edge extension can return create_tab before Chrome
  // commits the new document, especially immediately after a full Windows
  // package compile/install. Observe only this disposable test-owned tab;
  // never inspect a human browser profile or relax owner-origin grants.
  const match = /^tab:(\d+)$/.exec(pageId);
  assert.ok(match, "created owned tab ID is not a native Chrome tab reference");
  const ownedTabId = Number(match[1]);
  let committed = { ready: false, expectedOrigin: false };
  try {
    await until(async () => {
      const observed = await evaluatePage(extensionTarget.webSocketDebuggerUrl,
        "chrome.tabs.get(" + ownedTabId +
        ").then(t=>({status:t.status,url:t.url}))");
      const tab = observed.result?.value;
      committed = {
        ready: tab?.status === "complete",
        expectedOrigin: typeof tab?.url === "string" &&
          tab.url.startsWith(fixtureUrl),
      };
      return committed.ready && committed.expectedOrigin;
    }, 20000, "owned test-only tab document did not commit its approved origin");
  } catch (error) {
    result.ownedTabDiagnostic = committed;
    throw error;
  }

  let snapshotDiagnostic = null;
  let snapshot;
  try {
    snapshot = await until(async () => {
      const current = await rpc(rpcPort, "snapshot", {page_id: pageId});
      if (current.status !== "success") {
        snapshotDiagnostic = {
          status: current.status,
          errorCode: String(current.error?.code ?? "unknown").slice(0, 50),
        };
        return null;
      }
      const nodes = Array.isArray(current.data?.nodes)
        ? current.data.nodes : [];
      const input = nodes.find(x => x.accessible_name === "Release marker");
      const button = nodes.find(x => x.accessible_name === "Commit fixture action");
      snapshotDiagnostic = {
        status: "success",
        sameFixtureOrigin: typeof current.data?.url === "string" &&
          current.data.url.startsWith(fixtureUrl),
        nodeCount: nodes.length,
        inputVisible: Boolean(input),
        buttonVisible: Boolean(button),
      };
      return input && button ? {input, button} : null;
    }, 25000, "owned tab did not expose semantic nodes");
  } catch (error) {
    // Only fixture state and bounded metadata, never page text or secrets.
    result.snapshotDiagnostic = snapshotDiagnostic;
    throw error;
  }

  const action = await rpc(rpcPort, "act", {
    page_id: pageId, actions: [{kind: "click", target: snapshot.button.ref}],
    expectations: [{kind: "value", target: snapshot.input.ref, equals: "clicked"}],
    timeout_ms: 5000,
  });
  assert.equal(action.status, "success", JSON.stringify(action.error));
  assert.equal(action.data.state, "verified", JSON.stringify(action.data));
  result.verifiedBrowserAction = true;

  // The extension popup may close or be absent from Chrome's tab list.
  // Exercise a real ordinary HTTP tab, then revoke a local synthetic grant.
  // A revoked tab must not remain readable by a remote browser RPC caller.
  const humanCreated = await evaluatePage(extensionTarget.webSocketDebuggerUrl,
    "chrome.tabs.create({url:" + JSON.stringify(fixtureUrl) +
    ",active:false}).then(tab=>({id:tab.id}))");
  const humanTabId = humanCreated.result?.value?.id;
  assert.ok(Number.isSafeInteger(humanTabId),
    "disposable browser did not create an unshared ordinary tab");
  // chrome.tabs.create can resolve before the requested document URL is
  // committed. Do not ask the owner-approval controller to share about:blank.
  await until(async () => {
    const live = await evaluatePage(popup.webSocketDebuggerUrl,
      "chrome.tabs.get(" + humanTabId + ").then(tab=>tab.url)");
    return live.result?.value?.startsWith(fixtureUrl) === true;
  }, 10000, "ordinary owner test tab has not committed its website origin");
  // The one-click grant works even after the pairing endpoint is closed.
  const activated = await evaluatePage(extensionTarget.webSocketDebuggerUrl,
    "chrome.tabs.update(" + humanTabId +
    ",{active:true}).then(t=>({id:t.id,active:t.active}))");
  assert.equal(activated.result?.value?.active, true);
  // Reopening the popup on another tab must refresh the per-tab status.
  await evaluatePage(popup.webSocketDebuggerUrl, "location.reload(); true");
  await until(async () => {
    try {
      const page = await evaluatePage(popup.webSocketDebuggerUrl,
        "({ready:document.readyState,connect:!!document.querySelector('#quick-connect')})");
      return page.result?.value?.ready === "complete" && page.result?.value?.connect;
    } catch { return false; }
  }, 10000, "owner popup did not reopen for the second tab");
  const oneClick = await evaluatePage(popup.webSocketDebuggerUrl,
    "(()=>{const c=document.querySelector('#quick-connect');" +
    "const nav=document.querySelector('#share-navigate');" +
    "if(!c||!nav)return false;nav.checked=true;c.click();return true;})()");
  assert.equal(oneClick.result?.value,true,
    "one-click owner popup did not expose the primary Connect this tab action");
  await until(async () => {
    const approved = await rpc(rpcPort, "pages");
    return approved.data?.pages?.find(p =>
      p.tab_id===humanTabId && p.ownership==="shared-authorized") ?? null;
  }, 12000, "one-click popup did not share the owner-selected tab");
  const ui = await evaluatePage(popup.webSocketDebuggerUrl,
    "({status:document.querySelector('#share-status')?.textContent||''," +
    "connection:document.querySelector('#connection-state')?.textContent||''})");
  result.oneClickPopupStatus = ui.result?.value ?? {};
  assert.match(ui.result?.value?.status ?? "",
    /Current tab connected|This tab is shared/,
    "one-click popup did not confirm the owner grant");
  result.oneClickOwnerPopupConnected=true;

  // Exercise actual shared ownership in Edge, not a mock: exact origin
  // permitting same-site navigation but rejecting a different loopback port.
  const sharedPages = await rpc(rpcPort, "pages");
  const sharedPage = sharedPages.data?.pages?.find(p => p.tab_id === humanTabId);
  assert.equal(sharedPage?.ownership, "shared-authorized");
  assert.equal(sharedPage?.grant?.origin, new URL(fixtureUrl).origin);
  result.sharedOriginPinned = true;

  // Regression: repeated concurrent snapshots and page enumeration must
  // remain responsive after a successful owner-approved tab snapshot.
  // Only the local, disposable fixture is observed; no human account data.
  for (let cycle = 0; cycle < 8; cycle++) {
    const [snapshotAgain, listedAgain] = await Promise.all([
      rpc(rpcPort, "snapshot", {page_id: sharedPage.page_id}),
      rpc(rpcPort, "pages"),
    ]);
    assert.equal(snapshotAgain.status, "success",
      "shared snapshot failed on cycle " + cycle + ": " +
      String(snapshotAgain.error?.code ?? "unknown"));
    assert.equal(listedAgain.status, "success",
      "authorized pages blocked on cycle " + cycle);
    assert.ok(listedAgain.data.pages.some(p =>
      p.page_id === sharedPage.page_id && p.ownership === "shared-authorized"),
      "owner-authorized tab disappeared while read-only requests overlapped");
  }
  result.repeatedAuthorizedReads = true;

  const unrelatedPort = await availablePort();
  const unauthorizedUrl = "http://127.0.0.1:" + unrelatedPort + "/not-approved";
  const wrongOrigin = await rpc(rpcPort, "navigate", {
    page_id: sharedPage.page_id, url: unauthorizedUrl,
  });
  assert.equal(wrongOrigin.status, "error");
  assert.equal(wrongOrigin.error?.code, "permission_denied");
  result.crossOriginNavigationDenied = true;

  const sameOrigin = await rpc(rpcPort, "navigate", {
    page_id: sharedPage.page_id, url: fixtureUrl + "?same-origin-test=1",
  });
  assert.equal(sameOrigin.status, "success",
    "approved same-origin navigation must remain usable");
  // Simulate a human/website redirect rather than an agent mutation.
  const humanRedirect = await evaluatePage(popup.webSocketDebuggerUrl,
    "chrome.tabs.update(" + humanTabId + ",{url:" +
    JSON.stringify(unauthorizedUrl) + "}).then(tab=>({id:tab.id}))");
  assert.equal(humanRedirect.result?.value?.id, humanTabId);
  await until(async () => {
    const current = await evaluatePage(popup.webSocketDebuggerUrl,
      "chrome.tabs.get(" + humanTabId + ").then(tab=>tab.url)");
    return current.result?.value === unauthorizedUrl;
  }, 10000, "browser did not commit test-only cross-origin redirect");
  const afterRedirect = await rpc(rpcPort, "snapshot", {
    page_id: sharedPage.page_id,
  });
  assert.equal(afterRedirect.status, "error",
    "remote snapshot read a shared tab after cross-origin redirect");
  assert.equal(afterRedirect.error?.code, "permission_denied");
  result.redirectRevoked = true;

  const locallyRevoked = await evaluatePage(popup.webSocketDebuggerUrl,
    "chrome.runtime.sendMessage({type:'tetherplane.detach_current_tab',tab_id:" +
    humanTabId + "})");
  assert.equal(locallyRevoked.result?.value?.ok, true,
    "synthetic local owner could not revoke fixture tab access");
  const pages = await rpc(rpcPort, "pages");
  const humanPage = pages.data?.pages?.find(p => p.tab_id === humanTabId);
  assert.equal(humanPage, undefined,
    "unshared human tab metadata leaked after owner revoked sharing");
  const forbidden = await rpc(rpcPort, "snapshot", {page_id: "tab:" + humanTabId});
  assert.equal(forbidden.status, "error",
    "RELEASE_NO_GO: remote snapshot still reads a revoked human-owned tab");
  assert.equal(forbidden.error.code, "permission_denied");
  result.humanTabDenied = true;

  const ownedUnshared = await rpc(rpcPort, "create_tab", {url: fixtureUrl});
  assert.equal(ownedUnshared.status, "success");
  const siteRevoked = await evaluatePage(popup.webSocketDebuggerUrl,
    "chrome.runtime.sendMessage({type:'tetherplane.revoke_owned_site',tab_id:" +
    approvalTabId + "})");
  assert.equal(siteRevoked.result?.value?.ok, true, "local site revoke failed");
  const afterSiteRevoke = await rpc(rpcPort, "snapshot", {
    page_id: ownedUnshared.data.page_id,
  });
  assert.equal(afterSiteRevoke.status, "error", "revoked AI site still readable");
  assert.equal(afterSiteRevoke.error?.code, "permission_denied");
  result.ownedSiteRevocationDenied = true;
  const closed = await rpc(rpcPort, "close", {page_id: pageId});
  assert.equal(closed.status, "error", "revoked AI tab must no longer allow remote close");
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
    result.verifiedBrowserAction && result.humanTabDenied &&
    result.unapprovedOwnedCreationDenied && result.ownedSiteGrantedLocally &&
    result.ownedSiteRevocationDenied &&
    result.oneClickInitialPairing && result.oneClickOwnerPopupConnected && result.sharedOriginPinned && result.repeatedAuthorizedReads && result.crossOriginNavigationDenied &&
    result.redirectRevoked && result.tokenRedacted &&
    !result.error) result.verdict = "PASS";
if (process.argv[4]) {
  await writeFile(process.argv[4], JSON.stringify(result), "utf8");
}
console.log("REAL_EXTENSION_ACCEPTANCE=" + JSON.stringify(result));
if (result.verdict !== "PASS") process.exitCode = 1;
