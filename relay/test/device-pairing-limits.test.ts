import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";

const hash = hashDeviceCredential(randomBytes(32).toString("hex"));

test("pending enrollment capacity is bounded and expired slots are reclaimed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const registry = await DeviceRegistry.open({
    pairingTtlMs: 50, maxPendingPairings: 2,
  } as Parameters<typeof DeviceRegistry.open>[0]);
  const first = await registry.startPairing({ deviceId: "LimitOne", credentialHash: hash });
  const second = await registry.startPairing({ deviceId: "LimitTwo", credentialHash: hash });
  await assert.rejects(registry.startPairing({ deviceId: "LimitThree", credentialHash: hash }), /pending.*limit|capacity/i);
  assert.equal(registry.peekPendingDeviceId(first.userCode), "LimitOne");
  t.mock.timers.tick(51);
  const third = await registry.startPairing({ deviceId: "LimitThree", credentialHash: hash });
  assert.equal(registry.peekPendingDeviceId(first.userCode), null);
  assert.equal(registry.peekPendingDeviceId(second.userCode), null);
  assert.equal(registry.peekPendingDeviceId(third.userCode), "LimitThree");
});

test("failed guesses throttle the account across both approval entrypoints without consuming the real code", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const registry = await DeviceRegistry.open({
    approvalRateLimit: { maxAttempts: 2, windowMs: 1000 },
  } as Parameters<typeof DeviceRegistry.open>[0]);
  const started = await registry.startPairing({ deviceId: "ApprovalLimit", credentialHash: hash });
  for (const userCode of ["BAD1-0000", "BAD2-0000"]) {
    await assert.rejects(registry.approvePairing({ accountId: "guessing-account", userCode }), /invalid|expired/i);
  }
  await assert.rejects(registry.approvePairing({
    accountId: "guessing-account", userCode: started.userCode,
  }), /too many.*approval|rate limit/i);
  assert.equal(registry.getDevice("ApprovalLimit"), null);
  assert.equal(registry.peekPendingDeviceId(started.userCode), "ApprovalLimit");
  t.mock.timers.tick(1001);
  await registry.approvePairing({ accountId: "guessing-account", userCode: started.userCode });
  assert.equal(registry.getDevice("ApprovalLimit")?.accountId, "guessing-account");
});

test("expected device is checked inside the same approval mutation that consumes the code", async () => {
  const registry = await DeviceRegistry.open();
  const started = await registry.startPairing({ deviceId: "ExpectedOne", credentialHash: hash });
  await assert.rejects(registry.approvePairing({
    accountId: "owner", userCode: started.userCode, expectedDeviceId: "ExpectedTwo",
  } as Parameters<DeviceRegistry["approvePairing"]>[0]), /does not match/i);
  assert.equal(registry.getDevice("ExpectedOne"), null);
  await registry.approvePairing({
    accountId: "owner", userCode: started.userCode, expectedDeviceId: "ExpectedOne",
  } as Parameters<DeviceRegistry["approvePairing"]>[0]);
  assert.equal(registry.getDevice("ExpectedOne")?.accountId, "owner");
});

test("approval throttling is isolated by authenticated account", async () => {
  const registry = await DeviceRegistry.open({
    approvalRateLimit: { maxAttempts: 1, windowMs: 60000 },
  } as Parameters<typeof DeviceRegistry.open>[0]);
  await assert.rejects(registry.approvePairing({ accountId: "guessing-account", userCode: "BAD1-0000" }));
  const started = await registry.startPairing({ deviceId: "UnaffectedOwner", credentialHash: hash });
  await registry.approvePairing({ accountId: "real-owner", userCode: started.userCode });
  assert.equal(registry.getDevice("UnaffectedOwner")?.accountId, "real-owner");
});
