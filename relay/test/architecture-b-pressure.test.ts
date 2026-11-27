import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { InvocationEnvelope } from "@tetherplane/protocol";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";
import { DeviceRouter, type RelayToDeviceMessage } from "../src/routing/device-router.ts";
import { PolicyStore } from "../src/policy/policy-store.ts";

const accountId = "fixture-account";
const deviceId = "pressure-fixture";
const identity = { accountId, clientId: "fixture-client", principalId: "human:fixture-account" };
const invocation = (id: string): InvocationEnvelope => ({
  protocol_version: "1.0", request_id: id, device_id: deviceId, principal_id: null, job_id: null,
  capability: "device.status", arguments: {}, actor: {id: identity.clientId, kind: "ai_client"},
  session_id: null, response_mode: "compact", idempotency_key: null, preconditions: [], expectations: [],
});
async function paired() {
  const registry = await DeviceRegistry.open();
  const pending = await registry.startPairing({deviceId, credentialHash: hashDeviceCredential("synthetic-pressure-fixture")});
  const binding = await registry.approvePairing({accountId, userCode: pending.userCode});
  return {registry, binding};
}

test("pending route pressure is bounded before dispatch; replacement starts with no inherited routes", async () => {
  const {registry} = await paired();
  const router = new DeviceRouter({registry, timeoutMs: 4000, maxPendingRoutesPerDevice: 2, maxPendingRoutes: 3});
  const sent: RelayToDeviceMessage[] = [];
  const old = router.connectDevice({accountId, deviceId, send: async message => {sent.push(message);}});
  const a = router.call(identity, invocation("first"));
  const b = router.call(identity, invocation("second"));
  const excess = router.call(identity, invocation("third"));
  try {
    assert.equal(sent.length, 2, "excess route must not be forwarded");
    const refused = await excess;
    assert.equal(refused.error?.code, "resource_conflict");
    assert.equal(refused.error?.details?.dispatched, false);
    const fresh: RelayToDeviceMessage[] = [];
    const replacement = router.connectDevice({accountId, deviceId, send: async message => {fresh.push(message);}});
    assert.equal((await a).error?.code, "disconnected");
    assert.equal((await b).error?.code, "disconnected");
    old.disconnect();
    const d = router.call(identity, invocation("replacement"));
    assert.equal(fresh.length, 1);
    replacement.disconnect();
    assert.equal((await d).error?.code, "disconnected");
  } finally {
    router.disconnectDevice(deviceId);
    await Promise.all([a, b, excess]);
  }
});

test("control report pressure retires only the overloaded generation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-control-pressure-"));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const started = new Promise<void>(resolve => {entered = resolve;});
  let stall = false;
  try {
    const {registry, binding} = await paired();
    const store = await PolicyStore.open({registry, stateFile: path.join(dir, "registry.json"), persistOps: {
      writeFile: async (p, data, opts) => {
        if (stall) { entered(); await gate; }
        await writeFile(p, data, opts);
      },
    }});
    await store.ensureDevicePolicy(binding);
    const router = new DeviceRouter({registry, policyStore: store, timeoutMs: 100, maxControlReportsPerDevice: 2, maxControlReports: 4});
    let retired = 0;
    const old = router.connectDevice({accountId, deviceId, send: async () => {}, retire: () => {retired++;}});
    stall = true;
    old.receive({type: "device_hello", deviceId, appliedPolicyRevision: 1});
    await started;
    old.receive({type: "device_telemetry", deviceId, status: {seq: 1}});
    old.receive({type: "device_telemetry", deviceId, status: {seq: 2}});
    assert.equal(retired, 1);
    assert.equal(router.isOnline(deviceId), false);
    const next = router.connectDevice({accountId, deviceId, send: async () => {}, retire: () => {throw new Error("replacement retired");}});
    old.receive({type: "device_telemetry", deviceId, status: {seq: 3}});
    stall = false;
    release();
    await router.drainControl();
    next.receive({type: "device_hello", deviceId, appliedPolicyRevision: 1});
    await router.drainControl();
    assert.equal(router.isOnline(deviceId), true);
    assert.equal(retired, 1);
    next.disconnect();
  } finally { release(); await rm(dir, {recursive: true, force: true}); }
});