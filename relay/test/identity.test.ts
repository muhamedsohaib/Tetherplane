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


test("simultaneous pending device codes cannot overwrite a different owner account", async () => {
  const registry = await DeviceRegistry.open();
  const ownerSecret = "first-owner-device-credential-at-least-32";
  const attackerSecret = "second-owner-device-credential-at-least-32";
  const original = await registry.startPairing({
    deviceId: "NewDevice",
    credentialHash: hashDeviceCredential(ownerSecret),
  });
  await assert.rejects(
    registry.startPairing({
      deviceId: "NewDevice",
      credentialHash: hashDeviceCredential(attackerSecret),
    }),
    /pending|already paired|in progress/i,
  );
  await registry.approvePairing({
    accountId: "account-a",
    userCode: original.userCode,
  });
  assert.equal(await registry.authenticateDevice("NewDevice", ownerSecret), "account-a");
  assert.equal(await registry.authenticateDevice("NewDevice", attackerSecret), null);
  assert.equal(registry.getDevice("NewDevice")?.accountId, "account-a");
});

test("pending owner review expires and never leaks device credential material", async () => {
  const registry = await DeviceRegistry.open({ pairingTtlMs: 1000 });
  const secret = "new-device-secret-for-owner-review-at-least-32";
  const pending = await registry.startPairing({
    deviceId: "ReviewDevice",
    credentialHash: hashDeviceCredential(secret),
  });
  const preview = registry.previewPairing({ userCode: pending.userCode });
  assert.deepEqual(Object.keys(preview).sort(), ["deviceId", "expiresAt"]);
  assert.equal(preview.deviceId, "ReviewDevice");
  assert.equal(preview.expiresAt, pending.expiresAt);
  assert.doesNotMatch(JSON.stringify(preview), /secret|credentialHash/i);
  assert.equal(await registry.authenticateDevice("ReviewDevice", secret), null);
  await registry.approvePairing({ accountId: "account-a", userCode: pending.userCode });
  assert.throws(() => registry.previewPairing({ userCode: pending.userCode }),
    /invalid|expired/i);
});


test("expired pending code can be replaced while a live binding remains protected", async () => {
  const registry = await DeviceRegistry.open({ pairingTtlMs: 15 });
  const first = await registry.startPairing({
    deviceId: "FreshGuest",
    credentialHash: hashDeviceCredential("first-credential-longer-than-16"),
  });
  await assert.rejects(
    registry.startPairing({
      deviceId: "FreshGuest",
      credentialHash: hashDeviceCredential("replacement-credential-longer-than-16"),
    }),
    /already pending/i,
  );
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.throws(() => registry.previewPairing({ userCode: first.userCode }), /expired|invalid/i);
  const replacement = await registry.startPairing({
    deviceId: "FreshGuest",
    credentialHash: hashDeviceCredential("replacement-credential-longer-than-16"),
  });
  assert.notEqual(replacement.userCode, first.userCode);
  const binding = await registry.approvePairing({
    accountId: "account-a", userCode: replacement.userCode,
  });
  assert.equal(binding.accountId, "account-a");
  await assert.rejects(
    registry.startPairing({
      deviceId: "FreshGuest",
      credentialHash: hashDeviceCredential("third-credential-longer-than-16"),
    }),
    /already paired/i,
  );
});

test("unauthenticated pending-pairing memory is bounded", async () => {
  const registry = await DeviceRegistry.open();
  for (let i = 0; i < DeviceRegistry.MAX_PENDING_PAIRINGS; i++) {
    const requested = await registry.startPairing({
      deviceId: "Guest-" + i,
      credentialHash: hashDeviceCredential("guest-hash-source-" + i),
    });
    assert.match(requested.userCode, /^[A-F0-9]{4}-[A-F0-9]{4}$/);
  }
  await assert.rejects(
    registry.startPairing({
      deviceId: "OneMoreGuest",
      credentialHash: hashDeviceCredential("one-more-secret-credential"),
    }),
    /too many pending/i,
  );
});
