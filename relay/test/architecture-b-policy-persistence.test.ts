import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";
import { PolicyStore, type SynchronizedDevicePolicy } from "../src/policy/policy-store.ts";
import { DeviceRouter, type RelayToDeviceMessage } from "../src/routing/device-router.ts";
import type { InvocationEnvelope } from "@tetherplane/protocol";

const accountId = "fixture-account";
const deviceId = "fixture-device";
const actorPrincipalId = "human:fixture-account";
const identity = {accountId, clientId: "fixture-client", principalId: actorPrincipalId};

async function fixture(dir: string) {
  const stateFile = path.join(dir, "registry.json");
  const registry = await DeviceRegistry.open({stateFile});
  const pairing = await registry.startPairing({deviceId, credentialHash: hashDeviceCredential("synthetic-fixture-credential")});
  const binding = await registry.approvePairing({accountId, userCode: pairing.userCode});
  let failure: string | null = null;
  let writeGate: (() => Promise<void>) | null = null;
  const store = await PolicyStore.open({registry, stateFile, persistOps: {
    writeFile: async (p, data, opts) => {
      if (writeGate) await writeGate();
      if (failure) throw Object.assign(new Error("synthetic persistence failure"), {code: failure});
      await writeFile(p, data, opts);
    },
  }});
  await store.ensureDevicePolicy(binding);
  const sent: SynchronizedDevicePolicy[] = [];
  store.setSyncHooks({
    pushPolicy: async (_id, policy) => { sent.push(structuredClone(policy)); return true; },
    isOnline: () => true,
    connectionEvidence: () => null,
  });
  const mutate = (mutation: Parameters<PolicyStore["updateDevicePolicy"]>[0]["mutation"]) =>
    store.updateDevicePolicy({accountId, actorPrincipalId, deviceId, mutation});
  return {stateFile, registry, binding, store, sent, mutate,
    fail: (code: string | null) => {failure = code;},
    gate: (next: (() => Promise<void>) | null) => {writeGate = next;},
  };
}

async function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-b-policy-"));
  try { await run(await fixture(dir)); }
  finally { await rm(dir, {recursive: true, force: true}); }
}

test("owner save failure does not publish or retain uncommitted authority, including ENOENT", async () => {
  await withFixture(async f => {
    for (const code of ["ENOENT", "EIO"]) {
      f.fail(code);
      await assert.rejects(f.mutate({revokeFamilies: ["process"]}), /synthetic persistence failure/);
      assert.equal(f.store.getRecord(deviceId)?.desiredRevision, 1);
      assert.deepEqual(f.store.getRecord(deviceId)?.policy.owner_policy.denied_families, []);
      assert.equal(f.sent.length, 0);
      assert.equal((await PolicyStore.open({registry: f.registry, stateFile: f.stateFile})).getRecord(deviceId)?.desiredRevision, 1);
    }
    f.fail(null);
    const committed = await f.mutate({revokeFamilies: ["process"]});
    assert.equal(committed.desiredRevision, 2);
    assert.deepEqual(committed.policy.owner_policy.denied_families, ["process"]);
  });
});

test("operator changes and removals persist before delivery; failed writes retain previous authority", async () => {
  await withFixture(async f => {
    const update = () => f.store.upsertOperatorPolicy({
      accountId, actorPrincipalId, operatorPrincipalId: "operator:fixture",
      mutation: {profileId: "read_only"},
    });
    f.fail("EIO");
    await assert.rejects(update(), /synthetic persistence failure/);
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.getRecord(deviceId)?.desiredRevision, 1);
    assert.deepEqual(f.store.getRecord(deviceId)?.policy.operator_policies, {});
    f.fail(null);
    await update();
    assert.equal(f.sent.length, 1);
    assert.ok(f.store.getRecord(deviceId)?.policy.operator_policies["operator:fixture"]);
    f.fail("EIO");
    await assert.rejects(f.store.removeOperatorPolicy({accountId, actorPrincipalId, operatorPrincipalId: "operator:fixture"}), /synthetic persistence failure/);
    assert.equal(f.sent.length, 1);
    assert.ok(f.store.getRecord(deviceId)?.policy.operator_policies["operator:fixture"]);
  });
});

test("owner change in progress exposes only committed authority and sends only after persistence", async () => {
  await withFixture(async f => {
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => {release = resolve;});
    const entered = new Promise<void>(resolve => {reached = resolve;});
    f.gate(async () => {reached(); await paused;});
    const changing = f.mutate({revokeFamilies: ["process"]});
    await entered;
    try {
      assert.equal(f.store.getRecord(deviceId)?.desiredRevision, 1);
      assert.equal(f.sent.length, 0);
    } finally { release(); }
    const result = await changing;
    assert.equal(result.desiredRevision, 2);
    assert.equal(f.sent.at(-1)?.revision, 2);
  });
});

test("concurrent owner changes return their own committed revisions without stale disk overwrite", async () => {
  await withFixture(async f => {
    const results = await Promise.all([
      f.mutate({revokeFamilies: ["process"], reason: "restrict"}),
      f.mutate({grantFamilies: ["process"], reason: "restore"}),
    ]);
    assert.deepEqual(results.map(r => r.desiredRevision), [2, 3]);
    assert.deepEqual(results[0]?.policy.owner_policy.denied_families, ["process"]);
    assert.deepEqual(f.sent.map(p => p.revision), [2, 3]);
    const restored = await PolicyStore.open({registry: f.registry, stateFile: f.stateFile});
    assert.equal(restored.getRecord(deviceId)?.desiredRevision, 3);
    assert.deepEqual(restored.getRecord(deviceId)?.policy.owner_policy.denied_families, []);
  });
});

test("restart loads saved policy before routing and holds until current-generation ACK", async () => {
  await withFixture(async f => {
    const updated = await f.mutate({revokeFamilies: ["process"]});
    const restored = await PolicyStore.open({registry: f.registry, stateFile: f.stateFile});
    const router = new DeviceRouter({registry: f.registry, policyStore: restored, timeoutMs: 25});
    const sent: RelayToDeviceMessage[] = [];
    const connection = router.connectDevice({accountId, deviceId, send: async message => {sent.push(message);}});
    const invocation: InvocationEnvelope = {
      protocol_version: "1.0", request_id: "fixture", device_id: deviceId, principal_id: null, job_id: null,
      capability: "device.status", arguments: {}, actor: {id: identity.clientId, kind: "ai_client"},
      session_id: null, response_mode: "compact", idempotency_key: null, preconditions: [], expectations: [],
    };
    assert.match((await router.call(identity, invocation)).error?.message ?? "", /sync pending/i);
    connection.receive({type: "device_hello", deviceId, appliedPolicyRevision: 1});
    await router.drainControl();
    const sync = sent.find(message => (message as {type: string}).type === "policy_sync") as unknown as {policy: SynchronizedDevicePolicy} | undefined;
    assert.equal(sync?.policy.revision, updated.desiredRevision);
    assert.deepEqual(sync?.policy.owner_policy.denied_families, ["process"]);
    connection.receive({type: "policy_ack", deviceId, revision: updated.desiredRevision, applied: true});
    await router.drainControl();
    assert.equal((await router.call(identity, {...invocation, capability: "process.run"})).error?.code, "permission_denied");
    assert.equal(sent.filter(m => m.type === "invoke").length, 0);
  });
});
test("a failed current-generation acknowledgement save cannot authorize a request", async () => {
  await withFixture(async f => {
    const router = new DeviceRouter({registry: f.registry, policyStore: f.store, timeoutMs: 25});
    const sent: RelayToDeviceMessage[] = [];
    const connection = router.connectDevice({accountId, deviceId, send: async message => {sent.push(message);}});
    connection.receive({type: "device_hello", deviceId, appliedPolicyRevision: 1});
    await router.drainControl();
    const revision = (await f.mutate({revokeFamilies: ["process"]})).desiredRevision;
    const invocation: InvocationEnvelope = {
      protocol_version: "1.0", request_id: "fixture", device_id: deviceId, principal_id: null, job_id: null,
      capability: "device.status", arguments: {}, actor: {id: identity.clientId, kind: "ai_client"},
      session_id: null, response_mode: "compact", idempotency_key: null, preconditions: [], expectations: [],
    };
    f.fail("EIO");
    connection.receive({type: "policy_ack", deviceId, revision, applied: true});
    await router.drainControl();
    assert.match((await router.call(identity, invocation)).error?.message ?? "", /sync pending/i);
    assert.equal(sent.filter(m => m.type === "invoke").length, 0);
    f.fail(null);
    connection.receive({type: "policy_ack", deviceId, revision, applied: true});
    await router.drainControl();
    await router.call(identity, invocation);
    assert.equal(sent.filter(m => m.type === "invoke").length, 1);
  });
});

test("reconnect during an authority save never dispatches or publishes the draft", async () => {
  await withFixture(async f => {
    const router = new DeviceRouter({registry: f.registry, policyStore: f.store, timeoutMs: 25});
    const first = router.connectDevice({accountId, deviceId, send: async () => {}});
    first.receive({type: "device_hello", deviceId, appliedPolicyRevision: 1});
    await router.drainControl();
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => {release = resolve;});
    const entered = new Promise<void>(resolve => {reached = resolve;});
    f.gate(async () => {reached(); await paused;});
    const changing = f.mutate({revokeFamilies: ["process"]});
    await entered;
    const sent: RelayToDeviceMessage[] = [];
    const replacement = router.connectDevice({accountId, deviceId, send: async message => {sent.push(message);}});
    replacement.receive({type: "device_hello", deviceId, appliedPolicyRevision: 1});
    const invocation: InvocationEnvelope = {
      protocol_version: "1.0", request_id: "fixture", device_id: deviceId, principal_id: null, job_id: null,
      capability: "device.status", arguments: {}, actor: {id: identity.clientId, kind: "ai_client"},
      session_id: null, response_mode: "compact", idempotency_key: null, preconditions: [], expectations: [],
    };
    try {
      assert.equal(f.store.getRecord(deviceId)?.desiredRevision, 1);
      assert.match((await router.call(identity, invocation)).error?.message ?? "", /sync pending/i);
      assert.equal(sent.length, 0);
    } finally { release(); }
    const committed = await changing;
    await router.drainControl();
    assert.equal(committed.desiredRevision, 2);
    assert.ok(sent.some(message => (message as {type: string}).type === "policy_sync"));
    assert.equal(sent.filter(m => m.type === "invoke").length, 0);
    assert.match((await router.call(identity, invocation)).error?.message ?? "", /sync pending/i);
  });
});
test("a stalled policy delivery cannot wedge subsequent committed authority changes", async () => {
  await withFixture(async f => {
    const router = new DeviceRouter({registry: f.registry, policyStore: f.store, timeoutMs: 25});
    let release!: () => void;
    const stalled = new Promise<void>(resolve => {release = resolve;});
    router.connectDevice({accountId, deviceId, send: async () => {await stalled;}});
    const changing = f.mutate({revokeFamilies: ["process"]});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<null>(resolve => {timer = setTimeout(() => resolve(null), 500);});
      const committed = await Promise.race([changing, deadline]);
      assert.ok(committed, "policy delivery must be bounded even if transport never settles");
      assert.equal(committed.desiredRevision, 2);
      assert.equal(f.store.getRecord(deviceId)?.desiredRevision, 2);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await changing;
    }
  });
});