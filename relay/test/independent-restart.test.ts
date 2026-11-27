import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { InvocationEnvelope } from "@tetherplane/protocol";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";
import { DeviceRouter, type RelayToDeviceMessage } from "../src/routing/device-router.ts";

const accountId = "test-account";
const deviceId = "test-device";
const identity = { accountId, clientId: "test-client", principalId: "human:test-account" };
const invocation: InvocationEnvelope = {
  protocol_version: "1.0", request_id: "restart-first-call",
  principal_id: identity.principalId, device_id: deviceId, job_id: null,
  capability: "device.status", arguments: {}, actor: { id: identity.clientId, kind: "ai_client" },
  session_id: null, response_mode: "compact", idempotency_key: null,
  preconditions: [], expectations: [],
};
async function paired(stateFile: string): Promise<DeviceRegistry> {
  const registry = await DeviceRegistry.open({ stateFile });
  const pairing = await registry.startPairing({ deviceId, credentialHash: hashDeviceCredential("synthetic-test-credential") });
  await registry.approvePairing({ accountId, userCode: pairing.userCode });
  return registry;
}

test("restart reconnect restores desired policy before any status read or invocation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-review-"));
  try {
    const stateFile = path.join(dir, "registry.json");
    const first = await paired(stateFile);
    await new DeviceRouter({ registry: first }).setDesiredPolicy(accountId, deviceId, ["device.status"]);
    const restored = await DeviceRegistry.open({ stateFile });
    const router = new DeviceRouter({ registry: restored, timeoutMs: 50 });
    const sent: RelayToDeviceMessage[] = [];
    const connection = router.connectDevice({ accountId, deviceId, send: async message => { sent.push(message); } });
    assert.deepEqual(sent, [{ type: "policy", version: 1, allowedCapabilities: ["device.status"] }]);
    const held = await router.call(identity, invocation);
    assert.equal(held.error?.code, "timeout");
    assert.match(held.error?.message ?? "", /sync pending/);
    assert.equal(sent.filter(message => message.type === "invoke").length, 0);
    connection.receive({ type: "policy_ack", version: 1, status: "applied", appliedCapabilities: ["device.status"] });
    assert.equal(router.getPolicySync(accountId, deviceId)?.pending, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("failed desired save leaves the prior registry state intact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-review-"));
  try {
    const stateFile = path.join(dir, "registry.json");
    const registry = await paired(stateFile);
    const router = new DeviceRouter({ registry });
    await router.setDesiredPolicy(accountId, deviceId, ["device.status"]);
    const temporary = `${stateFile}.tmp-${process.pid}`;
    await mkdir(temporary);
    try {
      await assert.rejects(router.setDesiredPolicy(accountId, deviceId, []));
    } finally { await rmdir(temporary); }
    assert.deepEqual(registry.getDesiredPolicy(deviceId), { version: 1, allowedCapabilities: ["device.status"] });
    const restored = await DeviceRegistry.open({ stateFile });
    assert.deepEqual(restored.getDesiredPolicy(deviceId), registry.getDesiredPolicy(deviceId));
    assert.equal(router.getPolicySync(accountId, deviceId)?.desiredVersion, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("concurrent desired saves return their own committed versions and converge on the last update", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-review-"));
  try {
    const stateFile = path.join(dir, "registry.json");
    const registry = await paired(stateFile);
    const router = new DeviceRouter({ registry });
    const results = await Promise.all([
      router.setDesiredPolicy(accountId, deviceId, ["device.status"]),
      router.setDesiredPolicy(accountId, deviceId, []),
    ]);
    assert.deepEqual(results, [{ version: 1, pushed: false }, { version: 2, pushed: false }]);
    assert.deepEqual(registry.getDesiredPolicy(deviceId), { version: 2, allowedCapabilities: [] });
    const restored = await DeviceRegistry.open({ stateFile });
    assert.deepEqual(restored.getDesiredPolicy(deviceId), registry.getDesiredPolicy(deviceId));
    assert.equal(router.getPolicySync(accountId, deviceId)?.desiredVersion, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a reconnect during a save sees only the committed revision and calls remain held", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-review-"));
  try {
    const registry = await paired(path.join(dir, "registry.json"));
    const router = new DeviceRouter({ registry, timeoutMs: 50 });
    await router.setDesiredPolicy(accountId, deviceId, ["device.status"]);
    // Delay the actual save at the registry boundary; no mock router.
    const save = registry.setDesiredPolicy.bind(registry);
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void;
    const started = new Promise<void>(resolve => { reached = resolve; });
    registry.setDesiredPolicy = async (id, desired) => {
      reached();
      await pause;
      await save(id, desired);
    };
    const changing = router.setDesiredPolicy(accountId, deviceId, []);
    await started;
    const sent: RelayToDeviceMessage[] = [];
    const connection = router.connectDevice({ accountId, deviceId, send: async message => { sent.push(message); } });
    try {
      assert.deepEqual(sent, [{ type: "policy", version: 1, allowedCapabilities: ["device.status"] }]);
      connection.receive({ type: "policy_ack", version: 1, status: "applied", appliedCapabilities: ["device.status"] });
      assert.equal(router.getPolicySync(accountId, deviceId)?.pending, true);
      const held = await router.call(identity, invocation);
      assert.match(held.error?.message ?? "", /sync pending/);
      assert.equal(sent.filter(message => message.type === "invoke").length, 0);
    } finally { release(); }
    assert.deepEqual(await changing, { version: 2, pushed: true });
    assert.deepEqual(sent.at(-1), { type: "policy", version: 2, allowedCapabilities: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("concurrent saves for different devices retain both committed settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-review-"));
  try {
    const stateFile = path.join(dir, "registry.json");
    const registry = await paired(stateFile);
    const other = await registry.startPairing({ deviceId: "test-other", credentialHash: hashDeviceCredential("synthetic-other-credential") });
    await registry.approvePairing({ accountId, userCode: other.userCode });
    const router = new DeviceRouter({ registry });
    await Promise.all([
      router.setDesiredPolicy(accountId, deviceId, ["device.status"]),
      router.setDesiredPolicy(accountId, "test-other", []),
    ]);
    const restored = await DeviceRegistry.open({ stateFile });
    assert.deepEqual(restored.getDesiredPolicy(deviceId), { version: 1, allowedCapabilities: ["device.status"] });
    assert.deepEqual(restored.getDesiredPolicy("test-other"), { version: 1, allowedCapabilities: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
