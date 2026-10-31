import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const owner = { accountId: "isolated-release-owner", clientId: "isolated-portal-editor", principalId: "human:owner" };
const ai = { ...owner, clientId: "isolated-chat-client" };
const outsider = { ...owner, clientId: "isolated-unapproved-client" };
const tokens = { owner: "synthetic-subprocess-owner-token", ai: "synthetic-subprocess-ai-token", outsider: "synthetic-subprocess-stranger-token" };
const deviceIds = ["Leno", "Surface", "RTX", "VAULTER"] as const;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic-cli-release-acceptance", version: "1" } } };

async function portInLoopback(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("Windows CLI subprocess preserves Leno-only authorization across a real process restart", { timeout: 45000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "tp-v5-owner-cli-subprocess-"));
  const stateFile = path.join(folder, "registry.json");
  const policyFile = path.join(folder, "authority.json");
  const ownerConfigFile = path.join(folder, "owner-config.json");
  const authFile = path.join(folder, "static-auth.json");
  const port = await portInLoopback();
  const base = "http://127.0.0.1:" + port;
  let active: ReturnType<typeof spawn> | null = null;
  let sockets: WebSocket[] = [];
  const secrets = new Map<string, string>();
  const childEnvironment = {
    ...process.env,
    TP_CLI_RELEASE_OWNER: tokens.owner,
    TP_CLI_RELEASE_AI: tokens.ai,
    TP_CLI_RELEASE_OUTSIDER: tokens.outsider,
  };

  async function stop() {
    for (const ws of sockets) ws.terminate();
    sockets = [];
    if (!active) return;
    const child = active;
    active = null;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Isolated relay subprocess did not stop")), 7000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  }

  t.after(async () => {
    try { await stop(); }
    finally { await rm(folder, { recursive: true, force: true }); }
  });

  const authConfig = { clients: [
    { token_env: "TP_CLI_RELEASE_OWNER", account_id: owner.accountId, client_id: owner.clientId, principal_id: owner.principalId },
    { token_env: "TP_CLI_RELEASE_AI", account_id: ai.accountId, client_id: ai.clientId, principal_id: ai.principalId },
    { token_env: "TP_CLI_RELEASE_OUTSIDER", account_id: outsider.accountId, client_id: outsider.clientId, principal_id: outsider.principalId },
  ] };
  await writeFile(authFile, JSON.stringify(authConfig));
  await writeFile(ownerConfigFile, JSON.stringify({ owner, stateFile: policyFile }));
  await writeFile(policyFile, JSON.stringify({ version: 1, revision: 0, enabled: false, grants: [] }) + "\n");
  const registry = await DeviceRegistry.open({ stateFile });
  for (const device of deviceIds) {
    const secret = "synthetic-process-restart-device-" + device;
    secrets.set(device, secret);
    const pairing = await registry.startPairing({ deviceId: device, credentialHash: hashDeviceCredential(secret) });
    await registry.approvePairing({ accountId: owner.accountId, userCode: pairing.userCode });
  }

  async function boot() {
    assert.equal(active, null, "previous isolated relay must be fully terminated");
    const child = spawn(process.execPath, [
      "--experimental-strip-types", "src/cli.ts", "--host", "127.0.0.1",
      "--port", String(port), "--allow-insecure-localhost",
      "--auth-config", authFile, "--state-file", stateFile,
      "--owner-authority-config", ownerConfigFile,
    ], { cwd: root, env: childEnvironment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    active = child;
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk).slice(0, 400); });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(base + "/healthz", { signal: AbortSignal.timeout(300) });
        if (response.status === 200) { ready = true; break; }
      } catch {}
      await sleep(80);
    }
    assert.equal(ready, true, "Isolated relay CLI failed to serve on loopback: " + stderr.slice(0, 800));
    assert.equal(child.exitCode, null, "Isolated relay process must remain running");
  }

  async function connectAll() {
    for (const device of deviceIds) {
      const ws = new WebSocket("ws://127.0.0.1:" + port + "/device", {
        headers: { authorization: "Device " + secrets.get(device), "x-tetherplane-device-id": device },
      });
      sockets.push(ws);
      ws.on("message", raw => {
        const message = JSON.parse(String(raw));
        if (message.type !== "invoke") return;
        ws.send(JSON.stringify({ type: "result", routeId: message.routeId,
          result: { protocol_version: "1.0", request_id: message.invocation.request_id,
            status: "success", data: { device, capability: message.invocation.capability },
            delta: null, error: null, policy: null, verification: "not_applicable",
            continuation: null, timing: { duration_ms: 1 } } }));
      });
      await once(ws, "open");
    }
  }

  async function ownerApi(route: string, token: string, method = "GET", body?: object) {
    const response = await fetch(base + route, {
      method,
      headers: { authorization: "Bearer " + token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, data: await response.json() };
  }

  async function mcp(token: string, name: string, op: string, device: string) {
    const headers = { authorization: "Bearer " + token,
      accept: "application/json, text/event-stream", "content-type": "application/json" };
    const opened = await fetch(base + "/mcp", {
      method: "POST", headers, body: JSON.stringify(initialize), signal: AbortSignal.timeout(3000),
    });
    assert.equal(opened.status, 200, "Synthetic MCP initialization must succeed");
    const session = opened.headers.get("mcp-session-id");
    assert.ok(session, "MCP session header is required");
    const invoked = await fetch(base + "/mcp", {
      method: "POST", headers: { ...headers, "mcp-session-id": session },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: { op, device } } }),
      signal: AbortSignal.timeout(3000),
    });
    return { status: invoked.status, body: await invoked.json() };
  }

  await boot();
  await connectAll();
  // These are synthetic test credentials and synthetic device WebSockets; never real agents.
  assert.equal((await mcp(tokens.ai, "device", "status", "Leno")).body.result?.isError, undefined);
  const initial = await ownerApi("/owner/leno", tokens.owner);
  assert.equal(initial.status, 200);
  assert.ok(initial.data.clients.some((client: {clientId: string}) => client.clientId === ai.clientId));
  assert.equal((await ownerApi("/owner/leno", tokens.outsider)).status, 403);
  assert.equal((await ownerApi("/owner/leno/grant", tokens.owner, "POST", {
    revision: 0, clientId: ai.clientId, principalId: ai.principalId, confirmation: "WRONG"
  })).status, 400);
  const staged = await ownerApi("/owner/leno/grant", tokens.owner, "POST", {
    revision: 0, clientId: ai.clientId, principalId: ai.principalId, confirmation: "TRUST Leno"
  });
  assert.equal(staged.status, 200);
  assert.deepEqual((await ownerApi("/owner/leno", tokens.owner)).data.enforcedDevices, []);
  const enforced = await ownerApi("/owner/leno/enforcement", tokens.owner, "POST", {
    revision: 1, enabled: true, confirmation: "ENFORCE Leno GRANTS"
  });
  assert.equal(enforced.status, 200);
  assert.equal((await mcp(tokens.ai, "process", "run", "Leno")).body.result?.isError, undefined);
  const blocked = await mcp(tokens.outsider, "process", "run", "Leno");
  assert.equal(blocked.body.result?.isError, true, "Unapproved client must be denied on enforced Leno");
  assert.match(JSON.stringify(blocked.body), /permission_denied/);
  for (const other of ["Surface", "RTX", "VAULTER"]) {
    assert.equal((await mcp(tokens.outsider, "device", "status", other)).body.result?.isError, undefined, other);
  }

  // Stop the OS process, not just a server object; persisted authority is then reloaded.
  await stop();
  await boot();
  const restoredPolicy = await ownerApi("/owner/leno", tokens.owner);
  assert.equal(restoredPolicy.status, 200);
  assert.equal(restoredPolicy.data.revision, 2);
  assert.equal(restoredPolicy.data.enabled, false);
  assert.deepEqual(restoredPolicy.data.enforcedDevices, ["Leno"]);
  assert.equal(restoredPolicy.data.grants.length, 1);
  assert.equal(restoredPolicy.data.clients.some((client: {clientId: string}) => client.clientId === ai.clientId), false,
    "Observed client cache must not survive process termination");
  await connectAll();
  assert.equal((await mcp(tokens.ai, "process", "run", "Leno")).body.result?.isError, undefined);
  const stillDenied = await mcp(tokens.outsider, "device", "status", "Leno");
  assert.equal(stillDenied.body.result?.isError, true);
  assert.match(JSON.stringify(stillDenied.body), /permission_denied/);
  for (const other of ["Surface", "RTX", "VAULTER"]) {
    assert.equal((await mcp(tokens.outsider, "device", "status", other)).body.result?.isError, undefined, other);
  }
  assert.equal((await ownerApi("/owner/leno/enforcement", tokens.owner, "POST", {
    revision: 1, enabled: false, confirmation: "RESTORE Leno LEGACY ACCESS"
  })).status, 409, "Stale rollback revision must be denied");
  const rollback = await ownerApi("/owner/leno/enforcement", tokens.owner, "POST", {
    revision: 2, enabled: false, confirmation: "RESTORE Leno LEGACY ACCESS"
  });
  assert.equal(rollback.status, 200);
  assert.equal(rollback.data.revision, 3);
  assert.deepEqual((await ownerApi("/owner/leno", tokens.owner)).data.enforcedDevices, []);
  assert.equal((await mcp(tokens.outsider, "device", "status", "Leno")).body.result?.isError, undefined,
    "Legacy Leno routing must recover after owner rollback");

  // The packaged CLI must refuse a globally enforcing historical policy
  // before it opens any network listener. This is an actual new child process.
  await stop();
  const corrupt = JSON.parse(await readFile(policyFile, "utf8"));
  corrupt.enabled = true;
  await writeFile(policyFile, JSON.stringify(corrupt) + "\n");
  const rejected = spawn(process.execPath, [
    "--experimental-strip-types", "src/cli.ts", "--host", "127.0.0.1",
    "--port", String(port), "--allow-insecure-localhost",
    "--auth-config", authFile, "--state-file", stateFile,
    "--owner-authority-config", ownerConfigFile,
  ], { cwd: root, env: childEnvironment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  active = rejected;
  let rejectedStderr = "";
  rejected.stderr?.on("data", chunk => { rejectedStderr += String(chunk).slice(0, 500); });
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  let exitResult: unknown[];
  try {
    exitResult = await Promise.race([
      once(rejected, "exit"),
      new Promise<never>((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error("Invalid-policy subprocess did not fail closed")), 7000);
      }),
    ]);
  } finally {
    if (exitTimer) clearTimeout(exitTimer);
  }
  assert.equal(exitResult[0], 1, "A globally enforcing policy must fail before the relay listens");
  assert.match(rejectedStderr, /Leno-only owner policy refuses global or unrelated device grants/);
  active = null;
  await assert.rejects(
    fetch(base + "/healthz", { signal: AbortSignal.timeout(400) }),
    "No listener must be left after policy rejection",
  );
});
