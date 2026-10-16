import assert from "node:assert/strict";
import test from "node:test";

import {
  DeviceRegistry,
  hashDeviceCredential,
} from "../src/devices/registry.ts";

const DEVICE = "EnrollmentIsolationPC";
const FIRST_SECRET = "local-first-credential-for-enrollment-test";
const SECOND_SECRET = "different-credential-for-enrollment-test";
const FIRST_HASH = hashDeviceCredential(FIRST_SECRET);
const SECOND_HASH = hashDeviceCredential(SECOND_SECRET);

test("a second pending enrollment cannot replace the first device identity", async () => {
  const registry = await DeviceRegistry.open();
  const first = await registry.startPairing({
    deviceId: DEVICE,
    credentialHash: FIRST_HASH,
  });

  await assert.rejects(
    registry.startPairing({ deviceId: DEVICE, credentialHash: SECOND_HASH }),
    /pending|already/i,
  );
  await assert.rejects(
    registry.startPairing({ deviceId: DEVICE, credentialHash: FIRST_HASH }),
    /pending|already/i,
  );

  await registry.approvePairing({
    accountId: "account-first",
    userCode: first.userCode,
  });
  assert.equal(registry.getDevice(DEVICE)?.accountId, "account-first");
  assert.equal(await registry.authenticateDevice(DEVICE, FIRST_SECRET), "account-first");
  assert.equal(await registry.authenticateDevice(DEVICE, SECOND_SECRET), null);
});

test("simultaneous enrollment requests cannot mint two valid codes for one device", async () => {
  const registry = await DeviceRegistry.open();
  const results = await Promise.allSettled([
    registry.startPairing({ deviceId: DEVICE, credentialHash: FIRST_HASH }),
    registry.startPairing({ deviceId: DEVICE, credentialHash: SECOND_HASH }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("a newly enrolled identity is possible after an abandoned code expires", async () => {
  const registry = await DeviceRegistry.open({ pairingTtlMs: 5 });
  const first = await registry.startPairing({
    deviceId: DEVICE,
    credentialHash: FIRST_HASH,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await registry.startPairing({
    deviceId: DEVICE,
    credentialHash: SECOND_HASH,
  });
  await assert.rejects(
    registry.approvePairing({ accountId: "account-first", userCode: first.userCode }),
    /invalid|expired/i,
  );
  await registry.approvePairing({ accountId: "account-second", userCode: second.userCode });
  assert.equal(await registry.authenticateDevice(DEVICE, FIRST_SECRET), null);
  assert.equal(await registry.authenticateDevice(DEVICE, SECOND_SECRET), "account-second");
});
