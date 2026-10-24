import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { InvocationEnvelope } from "@tetherplane/protocol";
import type { ClientIdentity } from "../src/auth/static-auth.ts";
import { OwnerDeviceAuthority } from "../src/access/owner-authority.ts";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";

const owner: ClientIdentity = { accountId: "account-a", clientId: "owner-portal", principalId: "human:owner" };
const chat: ClientIdentity = { accountId: "account-a", clientId: "chatgpt-existing-client", principalId: "human:operator" };
const otherChat: ClientIdentity = { ...chat, clientId: "other-client" };
const outsider: ClientIdentity = { accountId: "account-b", clientId: "owner-portal", principalId: "human:owner" };

function invocation(capability: string, args: Record<string, unknown> = {}): InvocationEnvelope {
  return {
    protocol_version: "1.0",
    request_id: "synthetic-qa-request", device_id: "Surface",
    principal_id: chat.principalId, job_id: null, capability, arguments: args,
    actor: { id: chat.clientId, kind: "ai_client" }, session_id: null,
    response_mode: "compact", idempotency_key: null,
    preconditions: [], expectations: [],
  };
}
async function fixture(t: import("node:test").TestContext) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "owner-device-qa-"));
  t.after(async () => { await rm(folder, { recursive: true, force: true }); });
  const registry = await DeviceRegistry.open({ stateFile: path.join(folder, "devices.json") });
  const pending = await registry.startPairing({ deviceId: "Surface", credentialHash: hashDeviceCredential("synthetic-owner-authority-secret") });
  const paired = await registry.approvePairing({ accountId: owner.accountId, userCode: pending.userCode });
  const file = path.join(folder, "authority.json");
  await writeFile(file, JSON.stringify({ version: 1, revision: 0, enabled: false, grants: [] }) + "\n", { mode: 0o600 });
  const auth = await OwnerDeviceAuthority.open({ owner, registry, stateFile: file });
  return { registry, auth, file, paired };
}

test("configured owner authority refuses missing policy state instead of silently re-enabling legacy access", async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "tp-owner-missing-state-"));
  t.after(async () => { await rm(folder, { recursive: true, force: true }); });
  const registry = await DeviceRegistry.open();
  await assert.rejects(
    () => OwnerDeviceAuthority.open({
      owner,
      registry,
      stateFile: path.join(folder, "never-created.json"),
    }),
    /state file is missing; refusing legacy authorization fallback/,
  );
});

test("owner grants require explicit identity, device pairing, revision, and confirmation", async t => {
  const f = await fixture(t);
  assert.equal(f.auth.snapshot(owner).enabled, false);
  assert.equal(f.auth.evaluate(chat, "Surface", f.paired.pairedAt, invocation("process.run")).allowed, true,
    "legacy path remains stable until owner activates a new policy");
  assert.throws(() => f.auth.snapshot(chat), /only the explicitly configured owner/);
  await assert.rejects(() => f.auth.replaceGrants(outsider, { revision: 0, grants: [] }), /only the explicitly configured owner/);
  await assert.rejects(() => f.auth.replaceGrants(owner, { revision: 0, grants: [{
    deviceId: "RTX", clientId: chat.clientId, principalId: chat.principalId, level: "operate",
  }] }), /not currently owned/);
  const revision = await f.auth.replaceGrants(owner, { revision: 0, grants: [{
    deviceId: "Surface", clientId: chat.clientId, principalId: chat.principalId, level: "observe",
  }] });
  assert.equal(revision, 1);
  await assert.rejects(() => f.auth.replaceGrants(owner, { revision: 0, grants: [] }), /changed; refresh/);
  await assert.rejects(() => f.auth.setEnabled(owner, { revision, enabled: true, confirmation: "YES" }), /exact owner confirmation/);
  assert.equal(await f.auth.setEnabled(owner, {
    revision, enabled: true, confirmation: "ENFORCE DEVICE GRANTS",
  }), 2);
  assert.equal(f.auth.evaluate(chat, "Surface", f.paired.pairedAt, invocation("device.status")).allowed, true);
  const denied = f.auth.evaluate(chat, "Surface", f.paired.pairedAt, invocation("process.run"));
  assert.equal(denied.allowed, false);
  assert.equal(f.auth.evaluate(otherChat, "Surface", f.paired.pairedAt, invocation("device.status")).allowed, false,
    "another authenticated ChatGPT OAuth client gets no implicit grant");
  const onDisk = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(onDisk.enabled, true);
  assert.equal(onDisk.grants[0].clientId, chat.clientId);
  assert.ok(!JSON.stringify(onDisk).includes("synthetic-owner-authority-secret"));
  const reopened = await OwnerDeviceAuthority.open({ owner, registry: f.registry, stateFile: f.file });
  assert.equal(reopened.evaluate(chat, "Surface", f.paired.pairedAt, invocation("process.run")).allowed, false);
  assert.equal(reopened.snapshot(owner).revision, 2);
});

test("batch child access cannot bypass read-only grant, nested calls and unknown capabilities deny", async t => {
  const f = await fixture(t);
  await f.auth.replaceGrants(owner, { revision: 0, grants: [{
    deviceId: "Surface", clientId: chat.clientId, principalId: chat.principalId, level: "observe",
  }] });
  await f.auth.setEnabled(owner, { revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS" });
  const batch = (ops: string[]) => invocation("batch.execute", { mode: "sequential", operations: ops.map(capability => ({ capability, arguments: {} })) });
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,batch(["device.status","filesystem.info"])).allowed,true);
  for (const caps of [["device.status","process.run"],["batch.execute"],["unknown.future_capability"]]) {
    assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,batch(caps)).allowed,false);
  }
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("filesystem.move")).allowed,false);
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("desktop.physical_pointer_move")).allowed,false);
});

test("operate grants exclude unrestricted shell and privileged foreground control", async t => {
  const f = await fixture(t);
  await f.auth.replaceGrants(owner, { revision: 0, grants: [{
    deviceId: "Surface", clientId: chat.clientId, principalId: chat.principalId, level: "operate",
  }] });
  await f.auth.setEnabled(owner, { revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS" });
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("filesystem.write")).allowed,true);
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("process.run")).allowed,false);
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("process.input")).allowed,false);
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("process.terminate")).allowed,false);
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("batch.execute",{operations:[{capability:"process.run"}]})).allowed,false);
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("batch.execute",{operations:[{capability:"process.input"}]})).allowed,false);
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("batch.execute",{operations:[{capability:"filesystem.write"}]})).allowed,true);
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("desktop.physical_pointer_move")).allowed,false);
  assert.equal(f.auth.evaluate(chat,"Surface",f.paired.pairedAt,invocation("batch.execute",{operations:[{capability:"process.run"},{capability:"process.terminate"}]})).allowed,false);
  const snap = f.auth.snapshot(owner);
  assert.ok(snap.clients.some(c => c.clientId === chat.clientId));
  assert.equal(snap.clients.every(c => !("token" in c)),true);
});

test("revocation deletes grants and new pairing cannot inherit previous access", async t => {
  const f = await fixture(t);
  await f.auth.replaceGrants(owner, { revision: 0, grants: [{
    deviceId: "Surface", clientId: chat.clientId, principalId: chat.principalId, level: "operate",
  }] });
  await f.auth.setEnabled(owner, { revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS" });
  await f.registry.revokeDevice({ accountId: owner.accountId, deviceId: "Surface" });
  await f.auth.revokeGrants("Surface");
  assert.equal(f.auth.snapshot(owner).grants.length,0);
  const pending = await f.registry.startPairing({ deviceId:"Surface", credentialHash:hashDeviceCredential("new-synthetic-pairing-secret") });
  const paired = await f.registry.approvePairing({accountId: owner.accountId,userCode: pending.userCode});
  assert.equal(f.auth.evaluate(chat,"Surface",paired.pairedAt,invocation("device.status")).allowed,false);
  const currentRevision = f.auth.snapshot(owner).revision;
  assert.equal(currentRevision, 3, "revoking a device must invalidate the old policy revision");
  await assert.rejects(() => f.auth.setEnabled(owner,{revision:currentRevision,enabled:false,confirmation:"ENABLE"}),/exact owner confirmation/);
  assert.equal(await f.auth.setEnabled(owner,{revision:currentRevision,enabled:false,confirmation:"RESTORE LEGACY ACCESS"}),currentRevision + 1);
});

test("concurrent owner edits are serialized with CAS instead of silently overwriting grants", async t => {
  const f = await fixture(t);
  const grant = { deviceId:"Surface",clientId:chat.clientId,principalId:chat.principalId,level:"observe" };
  const writes = await Promise.allSettled([
    f.auth.replaceGrants(owner, { revision:0, grants:[grant] }),
    f.auth.replaceGrants(owner, { revision:0, grants:[] }),
  ]);
  assert.equal(writes.filter(w=>w.status==="fulfilled").length,1);
  assert.equal(writes.filter(w=>w.status==="rejected").length,1);
  assert.equal(f.auth.snapshot(owner).revision,1);
});
