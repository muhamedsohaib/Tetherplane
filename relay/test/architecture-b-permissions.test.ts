import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { InvocationEnvelope, ResultEnvelope } from "@tetherplane/protocol";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";
import { DeviceRouter, type RelayToDeviceMessage } from "../src/routing/device-router.ts";
import { PolicyStore } from "../src/policy/policy-store.ts";
import { translateCompactCall } from "../../adapters/compact-mcp/src/translate.ts";

const accountId = "fixture-account";
const deviceId = "fixture-device";
const principalId = "human:fixture-account";
const identity = { accountId, clientId: "fixture-client", principalId };
const secret = "synthetic-fixture-not-a-live-credential";
const hash = hashDeviceCredential(secret);
const invocation = (capability = "device.status", args: Record<string, unknown> = {}): InvocationEnvelope => ({
  protocol_version: "1.0", request_id: "fixture-request",
  device_id: deviceId, principal_id: null, job_id: null, capability, arguments: args,
  actor: {id: "fixture-client", kind: "ai_client"}, session_id: null,
  response_mode: "compact", idempotency_key: null, preconditions: [], expectations: [],
});

async function pair(registry: DeviceRegistry) {
  const p = await registry.startPairing({deviceId, credentialHash: hash});
  return registry.approvePairing({accountId, userCode: p.userCode});
}

test("failed pairing save does not publish or consume the pairing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-b-registry-"));
  try {
    const stateFile = path.join(dir, "registry.json");
    let fail = true;
    const registry = await DeviceRegistry.open({stateFile, persistOps: {
      writeFile: async (p, data, opts) => {
        if (fail) throw Object.assign(new Error("synthetic write failure"), {code: "EIO"});
        await writeFile(p, data, opts);
      },
    }});
    const p = await registry.startPairing({deviceId, credentialHash: hash});
    await assert.rejects(registry.approvePairing({accountId, userCode: p.userCode}), /synthetic write failure/);
    assert.equal(registry.getDevice(deviceId), null);
    assert.equal(await registry.authenticateDevice(deviceId, secret), null);
    fail = false;
    await registry.approvePairing({accountId, userCode: p.userCode});
    assert.equal(await (await DeviceRegistry.open({stateFile})).authenticateDevice(deviceId, secret), accountId);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("concurrent pairing approval cannot transfer the same active device to a second account", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-b-registry-"));
  try {
    const stateFile = path.join(dir, "registry.json");
    const registry = await DeviceRegistry.open({stateFile});
    const p1 = await registry.startPairing({deviceId, credentialHash: hash});
    const p2 = await registry.startPairing({deviceId, credentialHash: hash});
    const results = await Promise.allSettled([
      registry.approvePairing({accountId, userCode: p1.userCode}),
      registry.approvePairing({accountId: "other-account", userCode: p2.userCode}),
    ]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(registry.getDevice(deviceId)?.accountId, accountId);
    assert.equal((await DeviceRegistry.open({stateFile})).getDevice(deviceId)?.accountId, accountId);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("failed revoke denies immediately and a repeated revoke persists the denial", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-b-registry-"));
  try {
    const stateFile = path.join(dir, "registry.json");
    let fail = false;
    const registry = await DeviceRegistry.open({stateFile, persistOps: {
      writeFile: async (p, data, opts) => {
        if (fail) throw Object.assign(new Error("synthetic write failure"), {code: "EIO"});
        await writeFile(p, data, opts);
      },
    }});
    await pair(registry);
    fail = true;
    await assert.rejects(registry.revokeDevice({accountId, deviceId}), /synthetic write failure/);
    assert.equal(await registry.authenticateDevice(deviceId, secret), null);
    fail = false;
    await registry.revokeDevice({accountId, deviceId});
    assert.equal(await (await DeviceRegistry.open({stateFile})).authenticateDevice(deviceId, secret), null);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

async function fixture() {
  const registry = await DeviceRegistry.open();
  const binding = await pair(registry);
  const store = await PolicyStore.open({registry});
  await store.ensureDevicePolicy(binding);
  const router = new DeviceRouter({registry, policyStore: store, timeoutMs: 25});
  const sent: RelayToDeviceMessage[] = [];
  function connect() {
    const handle = router.connectDevice({accountId, deviceId, send: async (message) => {
      sent.push(message);
      if (message.type === "invoke") {
        const result: ResultEnvelope = {
          protocol_version: "1.0", request_id: message.invocation.request_id, status: "success",
          data: {fixture: true}, delta: null, error: null, verification: "verified",
          continuation: null, policy: null, timing: {duration_ms: 0},
        };
        handle.receive({type: "result", routeId: message.routeId, result});
      }
    }});
    return handle;
  }
  let connection = connect();
  const ack = async (revision: number, target = deviceId, applied = true) => {
    connection.receive({type: "policy_ack", deviceId: target, revision, applied, currentRevision: applied ? revision : revision - 1});
    await router.drainControl();
  };
  connection.receive({type: "device_hello", deviceId, appliedPolicyRevision: 1});
  await router.drainControl();
  await ack(1);
  const mutate = async (mutation: Parameters<PolicyStore["updateDevicePolicy"]>[0]["mutation"]) =>
    store.updateDevicePolicy({accountId, actorPrincipalId: principalId, deviceId, mutation});
  return {registry, binding, store, router, sent, mutate, ack,
    replace: () => { const old = connection; connection = connect(); return old; },
    hello: async (revision: number, target = deviceId) => {
      connection.receive({type: "device_hello", deviceId: target, appliedPolicyRevision: revision});
      await router.drainControl();
    }};
}

test("batch containing denied child never reaches the agent", async () => {
  const f = await fixture();
  const change = await f.mutate({revokeFamilies: ["process"]});
  await f.ack(change.desiredRevision);
  const before = f.sent.filter(m => m.type === "invoke").length;
  const result = await f.router.call(identity, invocation("batch.execute", {
    mode: "parallel", operations: [{capability: "device.status", arguments: {}}, {capability: "process.run", arguments: {}}],
  }));
  assert.equal(result.error?.code, "permission_denied");
  assert.equal(f.sent.filter(m => m.type === "invoke").length, before);
});

test("pending or rejected expansion is held until the current generation acknowledges the desired revision", async () => {
  const f = await fixture();
  const restrictive = await f.mutate({revokeFamilies: ["process"]});
  await f.ack(restrictive.desiredRevision);
  const expansion = await f.mutate({grantFamilies: ["process"]});
  const v = expansion.desiredRevision;
  const before = f.sent.filter(m => m.type === "invoke").length;
  assert.match((await f.router.call(identity, invocation("process.run"))).error?.message ?? "", /sync pending/i);
  await f.ack(v, "another-device");
  assert.match((await f.router.call(identity, invocation("process.run"))).error?.message ?? "", /sync pending/i);
  await f.ack(v, deviceId, false);
  assert.match((await f.router.call(identity, invocation("process.run"))).error?.message ?? "", /sync pending/i);
  assert.equal(f.sent.filter(m => m.type === "invoke").length, before);
  await f.ack(v);
  assert.equal((await f.router.call(identity, invocation("process.run"))).status, "success");
});

test("replacement connection cannot inherit acknowledgement or accept a wrong-device hello", async () => {
  const f = await fixture();
  const change = await f.mutate({revokeFamilies: ["process"]});
  const v = change.desiredRevision;
  await f.ack(v);
  const old = f.replace();
  old.receive({type: "policy_ack", deviceId, revision: v, applied: true});
  assert.match((await f.router.call(identity, invocation())).error?.message ?? "", /sync pending/i);
  await f.hello(v, "other-device");
  assert.match((await f.router.call(identity, invocation())).error?.message ?? "", /sync pending/i);
  await f.hello(v);
  assert.equal((await f.router.call(identity, invocation())).status, "success");
});

test("browser.list_tabs canonicalizes at the compact adapter boundary", () => {
  assert.equal(translateCompactCall("browser", {op: "list_tabs"}).capability, "browser.pages");
});