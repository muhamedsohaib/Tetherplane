import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { InvocationEnvelope } from "@tetherplane/protocol";

import { RelayServer } from "../src/server.ts";
import { hashDeviceCredential } from "../src/devices/registry.ts";
import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";

const owner = { accountId: "account-a", clientId: "approved-owner-portal", principalId: "human:owner" };
const client = { accountId: "account-a", clientId: "chatgpt-one", principalId: "human:user" };
const other = { accountId: "account-a", clientId: "chatgpt-two", principalId: "human:user" };
const outsider = { accountId: "account-b", clientId: "approved-owner-portal", principalId: "human:owner" };

function invocation(capability: string, args: Record<string, unknown> = {}): InvocationEnvelope {
  return {
    protocol_version: "1.0", request_id: "synthetic-invocation-" + Math.random(),
    device_id: "Surface", principal_id: null, job_id: null,
    capability, arguments: args, actor: { id: "not-trusted", kind: "ai_client" },
    session_id: null, response_mode: "compact", idempotency_key: null,
    preconditions: [], expectations: [],
  };
}
async function harness(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-owner-control-"));
  const authenticator = new StaticClientAuthenticator([
    { token: "synthetic-owner-http-token", ...owner },
    { token: "synthetic-chat-token-a", ...client },
    { token: "synthetic-chat-token-b", ...client },
    { token: "synthetic-other-token", ...other },
    { token: "synthetic-outsider-token", ...outsider },
  ]);
  const relay = await RelayServer.create({
    authenticator, allowInsecureLocalhost: true,
    authority: { owner, stateFile: path.join(dir, "authority.json") },
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const wsList: WebSocket[] = [];
  t.after(async () => {
    for (const ws of wsList) ws.terminate();
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  });
  async function api(route: string, token: string | null = "synthetic-owner-http-token", method = "GET", body?: unknown) {
    const resp = await fetch(address.httpUrl + route, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: "Bearer " + token }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // A 401 challenge may intentionally have no JSON body. Preserve its
    // HTTP status rather than turning correct authentication denial into a
    // JSON parser error in the test harness.
    const raw = await resp.text();
    return { status: resp.status, data: raw ? JSON.parse(raw) : null };
  }
  const pending = await relay.registry.startPairing({
    deviceId: "Surface", credentialHash: hashDeviceCredential("synthetic-WS-credential-for-owner-QA"),
  });
  const pairing = await relay.registry.approvePairing({ accountId: owner.accountId, userCode: pending.userCode });
  async function connect() {
    const ws = new WebSocket(address.deviceWsUrl, {
      headers: { authorization: "Device synthetic-WS-credential-for-owner-QA",
        "x-tetherplane-device-id": "Surface" },
    });
    wsList.push(ws);
    let delivered = 0;
    ws.on("message", raw => {
      const msg = JSON.parse(String(raw));
      if (msg.type !== "invoke") return;
      delivered++;
      const i = msg.invocation;
      ws.send(JSON.stringify({
        type: "result", routeId: msg.routeId,
        result: {
          protocol_version: "1.0", request_id: i.request_id, status: "success",
          data: { synthetic: true, principalId: i.principal_id, clientId: i.actor.id },
          delta: null, error: null, policy: null,
          verification: "not_applicable", continuation: null,
          timing: { duration_ms: 1 },
        },
      }));
    });
    await once(ws, "open");
    for (let k = 0; k < 100 && !relay.router.isOnline("Surface"); k++)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(relay.router.isOnline("Surface"), true);
    return { ws, count: () => delivered };
  }
  return { relay, api, connect, pairing };
}

test("owner API rejects other clients even within the same paired account", async t => {
  const h = await harness(t);
  assert.equal((await h.api("/authority", null)).status, 401);
  assert.equal((await h.api("/authority", "synthetic-chat-token-a")).status, 403);
  assert.equal((await h.api("/authority", "synthetic-outsider-token")).status, 403);
  const initial = await h.api("/authority");
  assert.equal(initial.status, 200);
  assert.equal(initial.data.enabled, false);
  assert.equal(initial.data.revision, 0);
  const grant = { deviceId: "Surface", clientId: client.clientId, principalId: client.principalId, level: "observe" };
  assert.equal((await h.api("/authority/grants", "synthetic-chat-token-a", "PUT", { revision: 0, grants: [grant] })).status, 403);
  assert.equal((await h.api("/authority/grants", undefined, "PUT", { revision: 0, grants: [{ ...grant, deviceId: "RTX" }] })).status, 403);
  assert.equal((await h.api("/authority/grants", undefined, "PUT", { revision: 0, grants: [grant] })).status, 200);
  const conflict = await h.api("/authority/grants", undefined, "PUT", { revision: 0, grants: [] });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, "conflict");
  assert.equal((await h.api("/authority/enforcement", "synthetic-chat-token-b", "POST",
    { revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS" })).status, 403);
  assert.equal((await h.api("/authority/enforcement", undefined, "POST",
    { revision: 1, enabled: true, confirmation: "YES" })).status, 400);
  assert.equal((await h.api("/authority/enforcement", undefined, "POST",
    { revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS" })).status, 200);
  const enabled = await h.api("/authority");
  assert.equal(enabled.data.enabled, true);
  assert.equal(enabled.data.grants[0].pairedAt, h.pairing.pairedAt);
});

test("same OAuth identity gets consistent access across separate chat tokens; other client and batch child denied before dispatch", async t => {
  const h = await harness(t);
  await h.api("/authority/grants", undefined, "PUT", { revision: 0, grants: [
    { deviceId: "Surface", clientId: client.clientId, principalId: client.principalId, level: "observe" },
  ] });
  await h.api("/authority/enforcement", undefined, "POST",
    { revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS" });
  const peer = await h.connect();
  for (const token of ["synthetic-chat-token-a", "synthetic-chat-token-b"]) {
    const identity = await new StaticClientAuthenticator([{ token, ...client }]).authenticate(token);
    assert.ok(identity);
    const result = await h.relay.router.call(identity, invocation("device.status"));
    assert.equal(result.status, "success");
    assert.equal(result.data?.clientId, client.clientId);
  }
  assert.equal(peer.count(), 2);
  const denied = await h.relay.router.call(other, invocation("device.status"));
  assert.equal(denied.status, "error");
  assert.equal(denied.error?.code, "permission_denied");
  assert.equal(denied.policy?.source, "relay.owner_device_authority");
  assert.equal(peer.count(), 2);
  const mixed = await h.relay.router.call(client, invocation("batch.execute", {
    mode: "sequential",
    operations: [{ capability: "device.status", arguments: {} }, { capability: "process.run", arguments: {} }],
  }));
  assert.equal(mixed.error?.code, "permission_denied");
  assert.equal(peer.count(), 2);
  assert.equal((await h.relay.router.call(client, invocation("process.run"))).error?.code, "permission_denied");
  assert.equal(peer.count(), 2);
});

test("owner-only pair/revoke and revocation destroys grants without widening the local agent", async t => {
  const h = await harness(t);
  await h.api("/authority/grants", undefined, "PUT", { revision: 0, grants: [
    { deviceId: "Surface", clientId: client.clientId, principalId: client.principalId, level: "operate" },
  ] });
  await h.api("/authority/enforcement", undefined, "POST",
    { revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS" });
  const pending = await h.relay.registry.startPairing({
    deviceId: "Leno", credentialHash: hashDeviceCredential("synthetic-other-device-secret"),
  });
  assert.equal((await h.api("/pair/approve", "synthetic-chat-token-a", "POST", { userCode: pending.userCode })).status, 403);
  assert.equal((await h.api("/pair/approve", undefined, "POST", { userCode: pending.userCode })).status, 200);
  assert.equal((await h.api("/devices/Surface/revoke", "synthetic-chat-token-a", "POST", {})).status, 403);
  assert.equal((await h.api("/devices/Surface/revoke", undefined, "POST", {})).status, 200);
  const snapshot = await h.api("/authority");
  assert.equal(snapshot.data.grants.length, 0);
  assert.equal(snapshot.data.enabled, true);
  const newPending = await h.relay.registry.startPairing({
    deviceId: "Surface", credentialHash: hashDeviceCredential("synthetic-new-credential-no-inheritance"),
  });
  const paired = await h.relay.registry.approvePairing({ accountId: owner.accountId, userCode: newPending.userCode });
  assert.equal(h.relay.authority?.evaluate(client, "Surface", paired.pairedAt, invocation("device.status")).allowed, false);
});
