// Independent, disposable *loopback* owner-approval integration for a pinned Windows beta.
// Synthetic identities only. NEVER targets a production relay or existing device.
// Run with TETHERPLANE_ACCEPTANCE_PACKAGE pointing to an extracted, verified beta ZIP.
// Does NOT establish the new-device production OAuth acceptance or the 30s goal.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.TETHERPLANE_ACCEPTANCE_PACKAGE;
if (!packageRoot || !path.isAbsolute(packageRoot)) {
  throw new Error("TEST_REQUIRES_ABSOLUTE_EXTRACTED_PACKAGE_PATH");
}
const root = path.resolve(packageRoot);
const { RelayServer, StaticClientAuthenticator } = await import(
  pathToFileURL(path.join(root, "relay", "dist", "index.js")).href
);
const { Client } = await import(
  pathToFileURL(path.join(root, "adapters", "compact-mcp", "node_modules",
    "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js")).href
);
const { StreamableHTTPClientTransport } = await import(
  pathToFileURL(path.join(root, "adapters", "compact-mcp", "node_modules",
    "@modelcontextprotocol", "sdk", "dist", "esm", "client", "streamableHttp.js")).href
);
const { beginPairing, loadEnrollment, agentArguments } = await import(
  pathToFileURL(path.join(root, "scripts", "windows", "remote-enroll.mjs")).href
);
const tetherd = path.join(root, "bin", "tetherd.exe");
const name = "TPTEST_" + randomBytes(5).toString("hex").toUpperCase();
const tokenOwner = randomBytes(32).toString("base64url");
const tokenOther = randomBytes(32).toString("base64url");
const scratch = await mkdtemp(path.join(os.tmpdir(), "TP-AuthorizedPairing-Acceptance-"));
const allowedRoot = path.join(scratch, "allowed");
const enrollmentBase = path.join(scratch, "private-enrollment");
const relayState = path.join(scratch, "isolated-relay-registry.json");
let relay;
let agent;
let clientOwner;
let clientOther;
let codeWasApproved = false;
let revoked = false;
let disconnectedAfterRevoke = false;
const startMs = performance.now();

function elapsed(start = startMs) {
  return Math.round(performance.now() - start);
}

async function until(predicate, maxMs = 7000) {
  const begin = performance.now();
  while (elapsed(begin) < maxMs) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error("ACCEPTANCE_CONDITION_NOT_MET_WITHIN_BUDGET");
}

async function authenticatedRequest(baseUrl, pathname, token, method, body = undefined) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(4000),
  });
  return {
    status: response.status,
    body: response.status === 401 ? null : await response.json().catch(() => null),
  };
}

async function clientFor(url, token, label) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (dest, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", "Bearer " + token);
      return fetch(dest, { ...init, headers });
    },
  });
  const client = new Client({ name: label, version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function startAgent(enrollment, deviceWsUrl) {
  const args = agentArguments(enrollment);
  const urlIndex = args.indexOf("--relay-url");
  assert.ok(urlIndex >= 0);
  assert.equal(args[urlIndex + 1].startsWith("wss://"), true,
    "the shipped enrollment helper must default to authenticated WSS");
  args[urlIndex + 1] = deviceWsUrl;
  args.push("--relay-allow-insecure-localhost"); // explicitly isolated loopback TEST ONLY
  assert.ok(!args.some(a => typeof a === "string" && a.includes(tokenOwner)));
  const child = spawn(tetherd, args, {
    cwd: scratch,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => {
    const t = String(chunk);
    // Never store/emit raw credentials or unauthorized remote response bodies.
    if (stderr.length < 7000) stderr += t.slice(0, 7000 - stderr.length);
  });
  return { child, getStderr: () => stderr };
}

const evidence = {
  test: "NEW_WINDOWS_STATUS_ONLY_OWNER_APPROVED_LOOPBACK",
  testMode: "loopback-synthetic-static-bearer-not-public-oauth",
  sourceCommit: "e9fa529d9a3b2480a7c2c528a4370be9c143d181",
  guestId: name,
  hasPassedLocalNativeStatus: false,
  requiresRealOwnerOAuthTrial: true,
};
try {
  await mkdir(allowedRoot);
  await mkdir(enrollmentBase);
  const authenticator = new StaticClientAuthenticator([
    { token: tokenOwner, accountId: "tp-synthetic-owner",
      clientId: "acceptance-owner", principalId: "human:synthetic-owner" },
    { token: tokenOther, accountId: "tp-synthetic-other",
      clientId: "acceptance-other", principalId: "human:synthetic-other" },
  ]);
  relay = await RelayServer.create({
    authenticator,
    stateFile: relayState,
    allowInsecureLocalhost: true,
    routeTimeoutMs: 3000,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  assert.ok(address.httpUrl.startsWith("http://127.0.0.1:"),
    "must be non-public isolated loopback");
  evidence.relayLoopbackOnly = true;

  // The helper's HTTPS URL remains mandatory. In this *synthetic* integration,
  // the injected fetch dispatcher substitutes the isolated loopback relay.
  // A real HTTPS/WSS certificate/identity acceptance remains untested.
  const pairStartAt = performance.now();
  const result = await beginPairing({
    relayUrl: "https://trial-relay.invalid",
    deviceId: name,
    allowedRoot,
    outputBase: enrollmentBase,
  }, {
    fetchFn: async (url, init) => {
      assert.equal(url, "https://trial-relay.invalid/pair/start");
      assert.equal(init.redirect, "error");
      const body = JSON.parse(init.body);
      assert.equal(body.deviceId, name);
      assert.match(body.credentialHash, /^[0-9a-f]{64}$/);
      return fetch(address.httpUrl + "/pair/start", {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      });
    },
  });
  evidence.pairStartMs = elapsed(pairStartAt);
  assert.equal(result.deviceId, name);
  const enrollment = await loadEnrollment(result.directory);
  const rawSecret = (await readFile(enrollment.credentialFile, "utf8")).trim();
  assert.equal(rawSecret.length, 43);
  assert.equal(await relay.registry.authenticateDevice(name, rawSecret), null);
  evidence.beforeApprovalDenied = true;

  // Before approval, the real Windows native agent must be rejected.
  const unauthorized = startAgent(enrollment, address.deviceWsUrl);
  const preAuthExit = await new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => {
      unauthorized.child.kill();
      reject(Error("PRE_APPROVAL_AGENT_DID_NOT_EXIT"));
    }, 7000);
    unauthorized.child.once("error", err => { clearTimeout(watchdog); reject(err); });
    unauthorized.child.once("exit", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal });
    });
  });
  assert.notEqual(preAuthExit.code, 0);
  assert.match(unauthorized.getStderr(), /HTTP 401/);
  assert.equal(relay.router.isOnline(name), false);
  evidence.nativeBeforeApprovalDenied = true;

  // A distinct, authenticated *synthetic* owner must explicitly approve.
  const unauth = await authenticatedRequest(
    address.httpUrl, "/pair/approve", null, "POST", { userCode: result.userCode });
  assert.equal(unauth.status, 401);
  evidence.unauthenticatedApprovalDenied = true;
  const approvedAt = performance.now();
  const approved = await authenticatedRequest(
    address.httpUrl, "/pair/approve", tokenOwner, "POST", { userCode: result.userCode });
  assert.equal(approved.status, 200);
  assert.equal(approved.body?.accountId, "tp-synthetic-owner");
  assert.equal(await relay.registry.authenticateDevice(name, rawSecret), "tp-synthetic-owner");
  codeWasApproved = true;
  evidence.syntheticOwnerApproval = true;

  agent = startAgent(enrollment, address.deviceWsUrl).child;
  await until(() => relay.router.isOnline(name));
  clientOwner = await clientFor(address.mcpUrl, tokenOwner, "synthetic-owner");
  clientOther = await clientFor(address.mcpUrl, tokenOther, "synthetic-other");
  const tools = await clientOwner.listTools();
  assert.deepEqual(
    tools.tools.map(x => x.name).sort(),
    ["batch", "browser", "desktop", "device", "files", "process"]);
  evidence.sixMcpToolsVisible = true;
  const remoteStatus = await clientOwner.callTool({
    name: "device", arguments: { device: name, op: "status" },
  });
  assert.notEqual(remoteStatus.isError, true, JSON.stringify(remoteStatus).slice(0, 1000));
  evidence.firstAuthenticatedRemoteStatus = true;
  evidence.syntheticApprovalToFirstRemoteStatusMs = elapsed(approvedAt);

  const deniedFiles = await clientOwner.callTool({
    name: "files", arguments: { device: name, op: "read",
      args: { path: path.join(allowedRoot, "no-permission.txt") } },
  });
  assert.equal(deniedFiles.isError, true, JSON.stringify(deniedFiles).slice(0, 900));
  evidence.localFilesystemDenied = true;

  const otherDenied = await clientOther.callTool({
    name: "device", arguments: { device: name, op: "status" },
  });
  assert.equal(otherDenied.isError, true);
  evidence.crossAccountRoutingDenied = true;

  // A transport disconnect must not promote privilege or duplicate the agent.
  relay.deviceGateway.disconnectDevice(name);
  await until(() => !relay.router.isOnline(name), 4000);
  await until(() => relay.router.isOnline(name), 8500);
  const afterReconnect = await clientOwner.callTool({
    name: "device", arguments: { device: name, op: "status" },
  });
  assert.notEqual(afterReconnect.isError, true);
  evidence.reconnectedRemoteStatus = true;

  const foreignRevoke = await authenticatedRequest(
    address.httpUrl, "/devices/" + name + "/revoke", tokenOther, "POST", {});
  assert.equal(foreignRevoke.status, 403);
  evidence.foreignAccountRevocationDenied = true;

  const ownerRevoke = await authenticatedRequest(
    address.httpUrl, "/devices/" + name + "/revoke", tokenOwner, "POST", {});
  assert.equal(ownerRevoke.status, 200);
  revoked = true;
  await until(() => !relay.router.isOnline(name));
  disconnectedAfterRevoke = true;
  assert.equal(await relay.registry.authenticateDevice(name, rawSecret), null);
  evidence.revocationDisconnectsDevice = true;
  evidence.revokedCredentialRejected = true;

  evidence.elapsedSyntheticEndToEndMs = elapsed();
  evidence.realNewDeviceOwnerOAuthVerified = false;
  evidence.productionRelayModified = false;
  evidence.pass = true;
  process.stdout.write("TETHERPLANE_LOOPBACK_ENROLLMENT_ACCEPTANCE=" +
    JSON.stringify(evidence) + "\n");
} finally {
  await clientOther?.close().catch(() => {});
  await clientOwner?.close().catch(() => {});
  if (agent && agent.exitCode === null && agent.signalCode === null) {
    const exited = once(agent, "exit").catch(() => {});
    agent.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 4000))]);
  }
  await relay?.close().catch(() => {});
  // Only isolated scratch created by this test; never delete host installs.
  await rm(scratch, { recursive: true, force: true });
}
