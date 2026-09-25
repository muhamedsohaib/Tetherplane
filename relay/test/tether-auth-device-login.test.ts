import assert from "node:assert/strict";
import test from "node:test";

import {
  DeviceLoginCoordinator,
  type DeviceLoginProofConsumer,
} from "../../auth/src/device-login.ts";

test("device login resolves a one-time approval to only a Tetherplane account", async () => {
  const consumed: Array<{
    interactionUid: string;
    userCode: string;
  }> = [];
  const proofs: DeviceLoginProofConsumer = {
    async consume(input) {
      consumed.push(input);
      if (
        input.interactionUid === "interaction_123" &&
        input.userCode === "ABCD-1234"
      ) {
        return { accountId: "account-a" };
      }
      return null;
    },
  };
  const coordinator = new DeviceLoginCoordinator({ proofs });

  assert.deepEqual(
    await coordinator.complete({
      interactionUid: "interaction_123",
      userCode: "ABCD-1234",
    }),
    { accountId: "account-a" },
  );
  assert.deepEqual(consumed, [
    {
      interactionUid: "interaction_123",
      userCode: "ABCD-1234",
    },
  ]);
});

test("device login fails closed without exposing device credentials or arbitrary identities", async () => {
  let calls = 0;
  const coordinator = new DeviceLoginCoordinator({
    proofs: {
      async consume() {
        calls += 1;
        return {
          accountId: "account|unsafe",
          deviceCredential: "must-never-cross-auth-boundary",
        } as never;
      },
    },
  });

  await assert.rejects(
    coordinator.complete({
      interactionUid: "interaction_123",
      userCode: "ABCD-1234",
    }),
    /account/i,
  );
  assert.equal(calls, 1);

  for (const input of [
    {
      interactionUid: "../interaction",
      userCode: "ABCD-1234",
    },
    {
      interactionUid: "interaction_123",
      userCode: "raw-device-secret",
    },
  ]) {
    await assert.rejects(
      coordinator.complete(input),
      /interaction|code/i,
    );
  }
  assert.equal(calls, 1);
});

test("device login returns null for missing, expired, or already-consumed approval", async () => {
  const coordinator = new DeviceLoginCoordinator({
    proofs: {
      async consume() {
        return null;
      },
    },
  });

  assert.equal(
    await coordinator.complete({
      interactionUid: "interaction_123",
      userCode: "ABCD-1234",
    }),
    null,
  );
});
