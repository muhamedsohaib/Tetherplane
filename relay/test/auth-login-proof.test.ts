import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthLoginProofRegistry,
} from "../src/auth/login-proof-registry.ts";

test("auth login proof binds one interaction to one approved account and consumes once", () => {
  let now = 1_000;
  const registry = new AuthLoginProofRegistry({
    ttlMs: 60_000,
    now: () => now,
    randomBytes: () => Buffer.from("12345678", "utf8"),
  });

  const pending = registry.start({
    interactionUid: "interaction_123",
  });
  assert.match(
    pending.userCode,
    /^[A-Z0-9]{4}-[A-Z0-9]{4}$/,
  );
  assert.equal(
    pending.expiresAt,
    new Date(now + 60_000).toISOString(),
  );

  assert.equal(
    registry.consume({
      interactionUid: "interaction_123",
      userCode: pending.userCode,
    }),
    null,
  );

  registry.approve({
    interactionUid: "interaction_123",
    userCode: pending.userCode,
    accountId: "account-a",
  });

  assert.deepEqual(
    registry.consume({
      interactionUid: "interaction_123",
      userCode: pending.userCode,
    }),
    { accountId: "account-a" },
  );

  assert.equal(
    registry.consume({
      interactionUid: "interaction_123",
      userCode: pending.userCode,
    }),
    null,
  );
});

test("auth login proof rejects cross-interaction approval and expires closed", () => {
  let now = 5_000;
  const registry = new AuthLoginProofRegistry({
    ttlMs: 1_000,
    now: () => now,
    randomBytes: () => Buffer.from("ABCDEFGH", "utf8"),
  });

  const pending = registry.start({
    interactionUid: "interaction_abc",
  });

  assert.throws(
    () =>
      registry.approve({
        interactionUid: "interaction_xyz",
        userCode: pending.userCode,
        accountId: "account-a",
      }),
    /invalid|expired|interaction/i,
  );

  now += 1_001;

  assert.throws(
    () =>
      registry.approve({
        interactionUid: "interaction_abc",
        userCode: pending.userCode,
        accountId: "account-a",
      }),
    /invalid|expired/i,
  );

  assert.equal(
    registry.consume({
      interactionUid: "interaction_abc",
      userCode: pending.userCode,
    }),
    null,
  );
});

test("auth login proof stores no device credential and rejects unsafe identities", () => {
  const registry = new AuthLoginProofRegistry({
    randomBytes: () => Buffer.from("ZXCVBN12", "utf8"),
  });
  const pending = registry.start({
    interactionUid: "interaction_safe",
  });

  assert.throws(
    () =>
      registry.approve({
        interactionUid: "interaction_safe",
        userCode: pending.userCode,
        accountId: "account|unsafe",
      }),
    /account/i,
  );

  assert.throws(
    () =>
      registry.start({
        interactionUid: "../interaction",
      }),
    /interaction/i,
  );
});
