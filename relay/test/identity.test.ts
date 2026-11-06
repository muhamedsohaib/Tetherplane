import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import test from "node:test";

import {
  DeviceRegistry,
  hashDeviceCredential,
} from "../src/devices/registry.ts";
import {
  StaticClientAuthenticator,
} from "../src/auth/static-auth.ts";

test("pairing binds a locally generated credential hash to one account and persists no raw secret", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-relay-id-"));
  const stateFile = path.join(dir, "devices.json");
  const secret = "device-secret-that-must-never-be-stored";
  try {
    const registry = await DeviceRegistry.open({ stateFile });
    const pending = await registry.startPairing({
      deviceId: "Leno",
      credentialHash: hashDeviceCredential(secret),
    });

    assert.match(pending.pairingId, /^[0-9a-f-]{36}$/i);
    assert.match(pending.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const approved = await registry.approvePairing({
      accountId: "account-a",
      userCode: pending.userCode,
    });
    assert.equal(approved.deviceId, "Leno");
    assert.equal(approved.accountId, "account-a");

    assert.equal(
      await registry.authenticateDevice("Leno", secret),
      "account-a",
    );
    assert.equal(
      await registry.authenticateDevice("Leno", "wrong-secret"),
      null,
    );

    const persisted = await readFile(stateFile, "utf8");
    assert.doesNotMatch(persisted, /device-secret-that-must-never-be-stored/);
    assert.match(persisted, new RegExp(hashDeviceCredential(secret)));

    const reopened = await DeviceRegistry.open({ stateFile });
    assert.equal(
      await reopened.authenticateDevice("Leno", secret),
      "account-a",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pairing codes are one-time and cross-account revocation fails closed", async () => {
  const registry = await DeviceRegistry.open();
  const secret = "another-device-secret";
  const pending = await registry.startPairing({
    deviceId: "Leno",
    credentialHash: hashDeviceCredential(secret),
  });

  await registry.approvePairing({
    accountId: "account-a",
    userCode: pending.userCode,
  });
  await assert.rejects(
    registry.approvePairing({
      accountId: "account-a",
      userCode: pending.userCode,
    }),
    /pairing code/i,
  );
  await assert.rejects(
    registry.revokeDevice({
      accountId: "account-b",
      deviceId: "Leno",
    }),
    /not owned/i,
  );

  await registry.revokeDevice({
    accountId: "account-a",
    deviceId: "Leno",
  });
  assert.equal(
    await registry.authenticateDevice("Leno", secret),
    null,
  );
});

test("static client authentication binds account, client, and principal identity", async () => {
  const auth = new StaticClientAuthenticator([
    {
      token: "client-token-a",
      accountId: "account-a",
      clientId: "client-a",
      principalId: "human:account-a",
    },
  ]);

  assert.deepEqual(await auth.authenticate("client-token-a"), {
    accountId: "account-a",
    clientId: "client-a",
    principalId: "human:account-a",
  });
  assert.equal(await auth.authenticate("wrong"), null);
});

test("simultaneous pairing attempts cannot rebind one device ID to another account", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-relay-pair-race-"));
  const stateFile = path.join(dir, "devices.json");
  const ownerSecret = "owner-approved-secret-a-device";
  const competingSecret = "competing-unapproved-secret-b-device";
  try {
    const registry = await DeviceRegistry.open({stateFile});
    const [first, second] = await Promise.allSettled([
      registry.startPairing({
        deviceId: "New-Laptop",
        credentialHash: hashDeviceCredential(ownerSecret),
      }),
      registry.startPairing({
        deviceId: "New-Laptop",
        credentialHash: hashDeviceCredential(competingSecret),
      }),
    ]);
    const wins = [first, second].filter(x => x.status === "fulfilled");
    const rejects = [first, second].filter(x => x.status === "rejected");
    assert.equal(wins.length, 1);
    assert.equal(rejects.length, 1);
    assert.equal(rejects[0]?.status, "rejected");
    assert.match(String(rejects[0]?.status === "rejected" ? rejects[0].reason : ""), /active pending pairing code/);

    const approvedSecret = first.status === "fulfilled" ? ownerSecret : competingSecret;
    const deniedSecret = first.status === "fulfilled" ? competingSecret : ownerSecret;
    const acceptedCode = wins[0]?.status === "fulfilled" ? wins[0].value.userCode : null;
    assert.ok(acceptedCode);
    const bound = await registry.approvePairing({accountId: "account-owner", userCode: acceptedCode});
    assert.equal(bound.accountId, "account-owner");
    assert.equal(await registry.authenticateDevice("New-Laptop", approvedSecret), "account-owner");
    assert.equal(await registry.authenticateDevice("New-Laptop", deniedSecret), null);
    await assert.rejects(
      registry.startPairing({deviceId: "New-Laptop", credentialHash: hashDeviceCredential(deniedSecret)}),
      /already paired and must be revoked/,
    );
    const reloaded = await DeviceRegistry.open({stateFile});
    assert.equal(await reloaded.authenticateDevice("New-Laptop", approvedSecret), "account-owner");
    assert.equal(await reloaded.authenticateDevice("New-Laptop", deniedSecret), null);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});

test("different devices may enroll concurrently while an expired code cannot be approved", async () => {
  const registry = await DeviceRegistry.open({pairingTtlMs: 150});
  const olderSecret = "older-device-credential-for-expiry";
  const currentSecret = "newer-device-credential-for-approval";
  const old = await registry.startPairing({deviceId:"Expiring-Device",credentialHash:hashDeviceCredential(olderSecret)});
  const other = await registry.startPairing({deviceId:"Another-Device",credentialHash:hashDeviceCredential("third-device-credential-unique")});
  assert.notEqual(old.userCode,other.userCode);
  await new Promise(resolve=>setTimeout(resolve,200));
  const newer = await registry.startPairing({deviceId:"Expiring-Device",credentialHash:hashDeviceCredential(currentSecret)});
  await assert.rejects(
    registry.approvePairing({accountId:"account-wrong",userCode:old.userCode}),
    /invalid or expired/,
  );
  await registry.approvePairing({accountId:"account-owner",userCode:newer.userCode});
  assert.equal(await registry.authenticateDevice("Expiring-Device",olderSecret),null);
  assert.equal(await registry.authenticateDevice("Expiring-Device",currentSecret),"account-owner");
});
