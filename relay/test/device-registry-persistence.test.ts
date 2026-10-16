import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";

test("simultaneously approved distinct devices persist without lost bindings", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-pair-persist-"));
  let registry!: DeviceRegistry;
  let reloaded: DeviceRegistry | undefined;
  try {
    const stateFile = path.join(temp, "devices.json");
    registry = await DeviceRegistry.open({ stateFile });
    const pairings = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const deviceId = `PairingConcurrent${index}`;
      const secret = `distinct-local-credential-for-${deviceId}`;
      const pending = await registry.startPairing({
        deviceId,
        credentialHash: hashDeviceCredential(secret),
      });
      return { deviceId, secret, pending };
    }));
    const outcomes = await Promise.allSettled(pairings.map(({ pending }) =>
      registry.approvePairing({ accountId: "account-owner", userCode: pending.userCode }),
    ));
    assert.deepEqual(
      outcomes.filter((outcome) => outcome.status === "rejected"),
      [],
      "concurrent durable approvals must not collide on the same temporary file",
    );

    await registry.close();
    reloaded = await DeviceRegistry.open({ stateFile });
    assert.equal(reloaded.listDevices("account-owner").length, pairings.length);
    for (const pairing of pairings) {
      assert.equal(
        await reloaded.authenticateDevice(pairing.deviceId, pairing.secret),
        "account-owner",
      );
    }
  } finally {
    await registry?.close();
    await reloaded?.close();
    await rm(temp, { recursive: true, force: true });
  }
});


test("a failed durable approval leaves the device unpaired and its code recoverable", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-pair-failure-"));
  let registry!: DeviceRegistry;
  let reloaded: DeviceRegistry | undefined;
  try {
    const blocker = path.join(temp, "blocked-parent");
    registry = await DeviceRegistry.open({ stateFile: path.join(blocker, "devices.json") });
    await rename(blocker, blocker + "-previous");
    await writeFile(blocker, "not a directory");
    const started = await registry.startPairing({
      deviceId: "ApprovalMustBeDurable",
      credentialHash: hashDeviceCredential("approval-is-not-durable-without-disk"),
    });
    await assert.rejects(registry.approvePairing({
      accountId: "account-owner",
      userCode: started.userCode,
    }));
    assert.equal(registry.getDevice("ApprovalMustBeDurable"), null);
    assert.equal(registry.peekPendingDeviceId(started.userCode), "ApprovalMustBeDurable");
  } finally {
    await registry?.close();
    await reloaded?.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test("a failed durable revocation does not silently revoke the live in-memory device", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-revoke-failure-"));
  let registry!: DeviceRegistry;
  let reloaded: DeviceRegistry | undefined;
  try {
    const folder = path.join(temp, "state");
    const stateFile = path.join(folder, "devices.json");
    registry = await DeviceRegistry.open({ stateFile });
    const secret = "credential-for-failed-revocation-test";
    const started = await registry.startPairing({
      deviceId: "RevocationMustBeDurable",
      credentialHash: hashDeviceCredential(secret),
    });
    await registry.approvePairing({ accountId: "account-owner", userCode: started.userCode });
    await rename(folder, folder + "-previous");
    await writeFile(folder, "not a directory");

    await assert.rejects(registry.revokeDevice({
      accountId: "account-owner",
      deviceId: "RevocationMustBeDurable",
    }));
    assert.equal(registry.getDevice("RevocationMustBeDurable")?.revokedAt, null);
    assert.equal(await registry.authenticateDevice("RevocationMustBeDurable", secret), "account-owner");
  } finally {
    await registry?.close();
    await reloaded?.close();
    await rm(temp, { recursive: true, force: true });
  }
});
