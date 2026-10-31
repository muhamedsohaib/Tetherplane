import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { InvocationEnvelope } from "@tetherplane/protocol";
import { OwnerDeviceAuthority } from "../src/access/owner-authority.ts";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";

const owner = { accountId: "isolated-owner-account", clientId: "approved-owner-editor", principalId: "human:owner" };
const client = { accountId: owner.accountId, clientId: "existing-approved-chat-client", principalId: "human:owner" };
const other = { ...client, clientId: "different-client" };
const outsider = { ...client, accountId: "foreign-account" };
const devices = ["Surface", "Leno", "VAULTER", "RTX"] as const;

function request(deviceId: string, capability: string, arguments_: Record<string, unknown> = {}): InvocationEnvelope {
  return {
    protocol_version: "1.0", request_id: "isolated-leno-check", device_id: deviceId,
    principal_id: client.principalId, job_id: null, capability, arguments: arguments_,
    actor: { id: client.clientId, kind: "ai_client" }, session_id: null,
    response_mode: "compact", idempotency_key: null, preconditions: [], expectations: [],
  };
}

async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-leno-scoped-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const registry = await DeviceRegistry.open({ stateFile: path.join(dir, "registry.json") });
  const paired = new Map<string, string>();
  for (const deviceId of devices) {
    const pending = await registry.startPairing({
      deviceId, credentialHash: hashDeviceCredential("synthetic-unusable-test-credential-" + deviceId),
    });
    const device = await registry.approvePairing({ accountId: owner.accountId, userCode: pending.userCode });
    paired.set(deviceId, device.pairedAt);
  }
  const stateFile = path.join(dir, "authority.json");
  // Existing deployed state must continue working without a migration.
  await writeFile(stateFile, JSON.stringify({ version: 1, revision: 0, enabled: false, grants: [] }) + "\n");
  const authority = await OwnerDeviceAuthority.open({ owner, registry, stateFile });
  const evalAccess = (identity: typeof client, deviceId: string, capability = "device.status",
    args: Record<string, unknown> = {}, pairedAt = paired.get(deviceId)!) =>
    authority.evaluate(identity, deviceId, pairedAt, request(deviceId, capability, args)).allowed;
  return { dir, registry, paired, stateFile, authority, evalAccess };
}

async function stageLenoFull(f: Awaited<ReturnType<typeof fixture>>) {
  f.authority.observeClient(client); // simulate identity already authenticated through relay
  const revision = await f.authority.replaceGrants(owner, {
    revision: 0,
    grants: [{ deviceId: "Leno", clientId: client.clientId, principalId: client.principalId, level: "full" }],
  });
  assert.equal(revision, 1);
}

test("Leno-only owner enforcement preserves all three other devices in legacy mode", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.authority.snapshot(owner).enforcedDevices, []);
  await stageLenoFull(f);
  const revision = await f.authority.setDeviceEnforcement(owner, {
    revision: 1, deviceId: "Leno", enabled: true, confirmation: "ENFORCE Leno GRANTS",
  });
  assert.equal(revision, 2);
  const snapshot = f.authority.snapshot(owner);
  assert.equal(snapshot.enabled, false, "global enforcement must remain OFF");
  assert.deepEqual(snapshot.enforcedDevices, ["Leno"]);
  assert.equal(snapshot.grants.length, 1);
  for (const op of ["device.status", "process.run", "process.input", "process.terminate",
    "browser.act", "desktop.snapshot", "desktop.act", "desktop.physical_pointer_move"]) {
    assert.equal(f.evalAccess(client, "Leno", op), true, op);
  }
  assert.equal(f.evalAccess(client, "Leno", "future.unreviewed"), false);
  assert.equal(f.evalAccess(other, "Leno"), false);
  assert.equal(f.evalAccess(outsider, "Leno"), false);
  for (const otherDevice of ["Surface", "VAULTER", "RTX"]) {
    assert.equal(f.evalAccess(client, otherDevice, "process.run"), true, otherDevice);
    assert.equal(f.evalAccess(other, otherDevice, "device.status"), true, otherDevice);
  }
  assert.equal(f.evalAccess(client, "Leno", "batch.execute", { mode: "sequential",
    operations: [{ capability: "process.run", arguments: {} }, { capability: "desktop.act", arguments: {} }] }), true);
  assert.equal(f.evalAccess(client, "Leno", "batch.execute", { mode: "sequential",
    operations: [{ capability: "process.run" }, { capability: "unknown.future" }] }), false);
  assert.equal(f.evalAccess(client, "Leno", "batch.execute", {
    operations: [{ capability: "batch.execute" }],
  }), false);
  const reloaded = await OwnerDeviceAuthority.open({ owner, registry: f.registry, stateFile: f.stateFile });
  assert.deepEqual(reloaded.snapshot(owner).enforcedDevices, ["Leno"]);
  assert.equal(reloaded.evaluate(other, "Leno", f.paired.get("Leno")!, request("Leno", "device.status")).allowed, false);
});

test("device activation requires real owner, paired Leno, staged full grant, exact phrase and revision", async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.authority.setDeviceEnforcement(owner, {
    revision: 0, deviceId: "Leno", enabled: true, confirmation: "ENFORCE Leno GRANTS",
  }), /full grant/);
  await stageLenoFull(f);
  const enable = { revision: 1, deviceId: "Leno", enabled: true, confirmation: "ENFORCE Leno GRANTS" };
  await assert.rejects(() => f.authority.setDeviceEnforcement(other, enable), /owner/);
  await assert.rejects(() => f.authority.setDeviceEnforcement(owner, { ...enable, revision: 0 }), /changed/);
  await assert.rejects(() => f.authority.setDeviceEnforcement(owner, { ...enable, confirmation: "YES" }), /confirmation/);
  await assert.rejects(() => f.authority.setDeviceEnforcement(owner, { ...enable, deviceId: "Surface", confirmation: "ENFORCE Surface GRANTS" }), /full grant/);
  await assert.rejects(() => f.authority.setDeviceEnforcement(owner, { ...enable, deviceId: "unknown", confirmation: "ENFORCE unknown GRANTS" }), /paired/);
  assert.equal(f.authority.snapshot(owner).revision, 1);
  assert.equal(await f.authority.setDeviceEnforcement(owner, enable), 2);
  await assert.rejects(() => f.authority.setDeviceEnforcement(owner, enable), /changed/);
});

test("explicit Leno-only rollback restores its previous legacy routing, not other devices", async t => {
  const f = await fixture(t);
  await stageLenoFull(f);
  await f.authority.setDeviceEnforcement(owner, {
    revision: 1, deviceId: "Leno", enabled: true, confirmation: "ENFORCE Leno GRANTS",
  });
  await assert.rejects(() => f.authority.setDeviceEnforcement(owner, {
    revision: 2, deviceId: "Leno", enabled: false, confirmation: "YES",
  }), /confirmation/);
  assert.equal(await f.authority.setDeviceEnforcement(owner, {
    revision: 2, deviceId: "Leno", enabled: false, confirmation: "RESTORE Leno LEGACY ACCESS",
  }), 3);
  assert.equal(f.evalAccess(other, "Leno", "device.status"), true);
  assert.deepEqual(f.authority.snapshot(owner).enforcedDevices, []);
  assert.equal(f.authority.snapshot(owner).enabled, false);
  for (const deviceId of ["Surface", "VAULTER", "RTX"])
    assert.equal(f.evalAccess(other, deviceId, "device.status"), true);
});

test("revocation and re-pair do not silently re-enable legacy access or inherit full privileges", async t => {
  const f = await fixture(t);
  await stageLenoFull(f);
  await f.authority.setDeviceEnforcement(owner, {
    revision: 1, deviceId: "Leno", enabled: true, confirmation: "ENFORCE Leno GRANTS",
  });
  await f.registry.revokeDevice({ accountId: owner.accountId, deviceId: "Leno" });
  await f.authority.revokeGrants("Leno");
  assert.deepEqual(f.authority.snapshot(owner).enforcedDevices, ["Leno"]);
  const pending = await f.registry.startPairing({ deviceId: "Leno",
    credentialHash: hashDeviceCredential("new-synthetic-credential") });
  const fresh = await f.registry.approvePairing({ accountId: owner.accountId, userCode: pending.userCode });
  assert.notEqual(fresh.pairedAt, f.paired.get("Leno"));
  assert.equal(f.evalAccess(client, "Leno", "device.status", {}, fresh.pairedAt), false);
  assert.equal(f.evalAccess(other, "Leno", "device.status", {}, fresh.pairedAt), false);
  assert.equal(f.evalAccess(other, "RTX", "device.status"), true);
});

test("global legacy enabled semantics remain intact and conflict with device-specific mode", async t => {
  const f = await fixture(t);
  // Existing global toggle still enforces globally; scoped switch cannot silently override it.
  await f.authority.setEnabled(owner, { revision: 0, enabled: true, confirmation: "ENFORCE DEVICE GRANTS" });
  assert.equal(f.evalAccess(client, "RTX"), false);
  await assert.rejects(() => f.authority.setDeviceEnforcement(owner, {
    revision: 1, deviceId: "Leno", enabled: true, confirmation: "ENFORCE Leno GRANTS",
  }), /global/);
  assert.equal(f.authority.snapshot(owner).enabled, true);
});

test("invalid scoped policy state fails closed, and existing v1 policy loads", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.authority.snapshot(owner).enforcedDevices, []);
  for (const values of [["Leno", "Leno"], [".."], "Leno", ["Leno", false]]) {
    await writeFile(f.stateFile, JSON.stringify({
      version: 1, revision: 0, enabled: false, grants: [], enforcedDevices: values,
    }));
    await assert.rejects(() => OwnerDeviceAuthority.open({
      owner, registry: f.registry, stateFile: f.stateFile,
    }), /invalid owner authority state/);
  }
});


test("enforced Leno preserves exact owner editor read-only status/capabilities, not shell or desktop", async t => {
  const f = await fixture(t);
  await stageLenoFull(f);
  await f.authority.setDeviceEnforcement(owner, {
    revision: 1, deviceId: "Leno", enabled: true, confirmation: "ENFORCE Leno GRANTS",
  });
  for (const capability of ["device.status", "device.capabilities"])
    assert.equal(f.evalAccess(owner, "Leno", capability), true, capability);
  for (const capability of ["process.run", "filesystem.read", "desktop.snapshot", "batch.execute"])
    assert.equal(f.evalAccess(owner, "Leno", capability), false, capability);
  assert.equal(f.evalAccess(other, "Leno", "device.capabilities"), false);
  for (const deviceId of ["Surface", "VAULTER", "RTX"])
    assert.equal(f.evalAccess(owner, deviceId, "device.status"), true, deviceId);
});
