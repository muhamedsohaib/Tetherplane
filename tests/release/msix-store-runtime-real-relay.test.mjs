import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";

// Resolve the SDK from its declared relay workspace dependency; pnpm does
// not guarantee it exists in the repo-root node_modules.
const relayRequire = createRequire(new URL("../../relay/package.json", import.meta.url));
const { Client } = await import(pathToFileURL(relayRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(relayRequire.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href);

import { RelayServer } from "../../relay/src/server.ts";
import { StaticClientAuthenticator } from "../../relay/src/auth/static-auth.ts";
import { hashDeviceCredential } from "../../relay/src/devices/registry.ts";

// Exact compiled native agent + real relay + MCP. Nothing is executed on a
// live owner device. Only the repo's disposable Windows PR runner is allowed.
const eligible = process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_EVENT_NAME === "pull_request" &&
  process.env.RUNNER_OS === "Windows" &&
  process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
  (process.env.GITHUB_HEAD_REF?.startsWith("feature/msix-store-runtime-") ||
   process.env.GITHUB_HEAD_REF?.startsWith("feature/msix-store-private-candidate-") ||
   process.env.GITHUB_HEAD_REF === "fix/windows-zero-console-model-worker-20261030" ||
   process.env.GITHUB_HEAD_REF === "fix/store-windowless-owner-setup-20261030");

if (process.env.TETHERPLANE_REQUIRE_MSIX_REAL_RELAY === "1" && !eligible) {
  throw new Error("MSIX_REAL_RELAY_REQUIRED_TEST_INELIGIBLE");
}

async function safeJson(response) {
  const body = await response.text();
  return body.length === 0 ? {} : JSON.parse(body);
}

async function until(predicate, label, timeout = 9_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out: " + label);
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
  }
}

async function relayPost(base, path, input, token) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {})
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(6_000)
  });
  return { status: response.status, body: await safeJson(response) };
}

function createAgent(executable, settings) {
  const proc = spawn(executable, [
    "--relay-url", settings.ws,
    "--relay-allow-insecure-localhost", // Strictly same-host CI test mode
    "--device-id", settings.deviceId,
    "--device-credential-file", settings.credentialPath,
    "--allow", settings.allowedRoot,
    "--state-dir", settings.agentState
  ], {
    cwd: settings.root,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"]
  });
  // Do not capture or print logs that might contain confidential data.
  proc.stderr?.resume();
  const exited = new Promise((resolveExit, rejectExit) => {
    proc.once("exit", code => resolveExit(code));
    proc.once("error", rejectExit);
  });
  return { proc, exited };
}

async function closeAgent(agent) {
  if (!agent) return;
  if (agent.proc.exitCode === null && !agent.proc.killed) agent.proc.kill();
  let timer;
  try {
    await Promise.race([
      agent.exited.catch(() => undefined),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("test agent shutdown timed out")), 3_500);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function mcpClient(base, token) {
  const transport = new StreamableHTTPClientTransport(
    new URL(base + "/mcp"), {
      requestInit: {
        headers: { authorization: "Bearer " + token }
      }
    }
  );
  const client = new Client(
    { name: "msix-disposable-real-agent-test", version: "1" },
    { capabilities: {} }
  );
  await client.connect(transport);
  return client;
}

test("new authorized device: owner approval, real agent, authenticated MCP, denial, restart and revocation", {
  skip: !eligible,
  timeout: 65_000
}, async (t) => {
  const baseTemp = process.env.RUNNER_TEMP || tmpdir();
  const root = await mkdtemp(join(baseTemp, "msix-real-relay-gate-"));
  const stateFile = join(root, "relay-state.json");
  const agentState = join(root, "agent-state");
  const allowedRoot = join(root, "allowed-documents");
  await mkdir(allowedRoot, { recursive: true });
  await mkdir(agentState, { recursive: true });
  const exe = resolve("target", "release", "tetherd-agentw.exe");
  const secret = randomBytes(32).toString("base64url");
  const deviceId = "ci-msix-" + randomBytes(5).toString("hex");
  const credentialPath = join(root, "device-credential.txt");
  await writeFile(credentialPath, secret + "\n", { flag: "wx", mode: 0o600 });
  const ownerToken = randomBytes(32).toString("base64url");
  const strangerToken = randomBytes(32).toString("base64url");
  const authenticator = new StaticClientAuthenticator([
    { token: ownerToken, accountId: "ci-owner-a", clientId: "ci-owner-a", principalId: "human:ci-owner-a" },
    { token: strangerToken, accountId: "ci-stranger-b", clientId: "ci-stranger-b", principalId: "human:ci-stranger-b" }
  ]);

  let relay;
  let agent;
  let owner;
  let stranger;
  t.after(async () => {
    await Promise.allSettled([owner?.close(), stranger?.close()]);
    if (agent) await closeAgent(agent).catch(() => undefined);
    if (relay) await relay.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  relay = await RelayServer.create({
    authenticator, stateFile, allowInsecureLocalhost: true, routeTimeoutMs: 3_500
  });
  const addresses = await relay.listen({ host: "127.0.0.1", port: 0 });
  assert.match(addresses.deviceWsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/device$/);

  // Unapproved credentials must not establish a device session.
  const pending = await relayPost(addresses.httpUrl, "/pair/start", {
    deviceId, credentialHash: hashDeviceCredential(secret)
  });
  assert.equal(pending.status, 200);
  assert.match(pending.body.userCode, /^[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(await relay.registry.authenticateDevice(deviceId, secret), null);
  const missingOwner = await relayPost(addresses.httpUrl, "/pair/approve", {
    userCode: pending.body.userCode
  });
  assert.equal(missingOwner.status, 401);
  const unauthenticatedMcp = await fetch(addresses.mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {},
        clientInfo: { name: "anonymous-ci", version: "1" } } }),
    signal: AbortSignal.timeout(4_000)
  });
  assert.equal(unauthenticatedMcp.status, 401);
  assert.equal(unauthenticatedMcp.headers.get("mcp-session-id"), null);
  assert.equal(relay.router.isOnline(deviceId), false);

  const approved = await relayPost(addresses.httpUrl, "/pair/approve", {
    userCode: pending.body.userCode
  }, ownerToken);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.deviceId, deviceId);
  assert.equal(approved.body.accountId, "ci-owner-a");
  assert.equal(await relay.registry.authenticateDevice(deviceId, secret), "ci-owner-a");

  const config = { ws: addresses.deviceWsUrl, deviceId, credentialPath, allowedRoot, agentState, root };
  agent = createAgent(exe, config);
  await until(() => relay.router.isOnline(deviceId), "first authenticated native WebSocket");

  owner = await mcpClient(addresses.httpUrl, ownerToken);
  stranger = await mcpClient(addresses.httpUrl, strangerToken);
  const tools = await owner.listTools();
  assert.deepEqual(tools.tools.map(x => x.name).sort(),
    ["batch", "browser", "desktop", "device", "files", "process"]);
  const status = await owner.callTool({ name: "device", arguments: { op: "status", device: deviceId } });
  assert.equal(status.isError, undefined, "real native agent must answer authenticated device.status");
  assert.equal(status.structuredContent?.os, "windows");
  const forbidden = await stranger.callTool({ name: "device", arguments: { op: "status", device: deviceId } });
  assert.equal(forbidden.isError, true);
  assert.equal(forbidden.structuredContent?.error?.code, "permission_denied");

  // Reconnect with the same credential and ID, with no new pairing.
  await closeAgent(agent);
  await until(() => !relay.router.isOnline(deviceId), "offline after controlled stop");
  agent = createAgent(exe, config);
  await until(() => relay.router.isOnline(deviceId), "authenticated reconnect without re-pair");
  const recovered = await owner.callTool({ name: "device", arguments: { op: "status", device: deviceId } });
  assert.equal(recovered.isError, undefined);
  assert.equal(recovered.structuredContent?.os, "windows");

  const revoked = await relayPost(addresses.httpUrl, "/devices/" + encodeURIComponent(deviceId) + "/revoke", {}, ownerToken);
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.revokedAt);
  await until(() => !relay.router.isOnline(deviceId), "offline on owner revocation");
  assert.equal(await relay.registry.authenticateDevice(deviceId, secret), null);
  const denied = await owner.callTool({ name: "device", arguments: { op: "status", device: deviceId } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent?.error?.code, "permission_denied");
  console.log("MSIX_REAL_RELAY_ACCEPTANCE_PASS: owner approval, six tools, native status, other-account denial, same-identity reconnect, revocation");
});
