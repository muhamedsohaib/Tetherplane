import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";

test("a short-code collision never replaces an earlier pending device", async (t) => {
  const registry = await DeviceRegistry.open();
  const original = crypto.randomBytes;
  let calls = 0;
  t.mock.method(crypto, "randomBytes", ((size: number) => {
    if (size !== 4) return original(size);
    calls += 1;
    return Buffer.from(calls <= 2 ? "11111111" : "22222222", "hex");
  }) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await registry.close(); });
  const first = await registry.startPairing({ deviceId: "CollisionOne", credentialHash: hashDeviceCredential("collision-one-local-test-credential") });
  const second = await registry.startPairing({ deviceId: "CollisionTwo", credentialHash: hashDeviceCredential("collision-two-local-test-credential") });
  assert.notEqual(first.userCode, second.userCode);
  assert.equal(registry.peekPendingDeviceId(first.userCode), "CollisionOne");
  assert.equal(registry.peekPendingDeviceId(second.userCode), "CollisionTwo");
});

test("repeated short-code collisions fail closed without consuming the existing pairing", async (t) => {
  const registry = await DeviceRegistry.open();
  t.mock.method(crypto, "randomBytes", (() => Buffer.from("11111111", "hex")) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await registry.close(); });
  const hash = hashDeviceCredential("local-test-credential-for-collision-failure");
  const first = await registry.startPairing({ deviceId: "CollisionOwner", credentialHash: hash });
  await assert.rejects(registry.startPairing({ deviceId: "CollisionRejected", credentialHash: hash }), /unique pairing code/i);
  assert.equal(registry.peekPendingDeviceId(first.userCode), "CollisionOwner");
});
