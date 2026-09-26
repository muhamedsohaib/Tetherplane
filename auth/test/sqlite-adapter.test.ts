import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  Adapter,
  AdapterPayload,
} from "oidc-provider";

import {
  createSqliteAdapter,
} from "../src/sqlite-adapter.ts";

test("SQLite adapter persists provider state across reopen", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tether-auth-sqlite-"),
  );
  const databasePath = path.join(
    temp,
    "provider.sqlite",
  );

  try {
    const first = createSqliteAdapter({
      databasePath,
    });
    const sessions: Adapter =
      new first.Adapter("Session");
    const payload: AdapterPayload = {
      uid: "session-uid",
      accountId: "account-1",
      clientId: "client-1",
      state: {
        nested: ["preserved", 7],
      },
    };

    await sessions.upsert(
      "session-1",
      payload,
      3_600,
    );
    first.close();

    const second = createSqliteAdapter({
      databasePath,
    });
    try {
      assert.deepEqual(
        await new second.Adapter("Session").find(
          "session-1",
        ),
        payload,
      );
    } finally {
      second.close();
    }
  } finally {
    await rm(temp, {
      recursive: true,
      force: true,
    });
  }
});

test("SQLite adapter enforces TTL and secondary lookups", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tether-auth-sqlite-"),
  );
  const databasePath = path.join(
    temp,
    "provider.sqlite",
  );
  let nowMs = 1_800_000_000_000;
  const store = createSqliteAdapter({
    databasePath,
    now: () => nowMs,
  });

  try {
    const codes: Adapter =
      new store.Adapter("DeviceCode");
    const payload: AdapterPayload = {
      userCode: "ABCD-1234",
      uid: "device-uid",
      grantId: "grant-device",
    };

    await codes.upsert(
      "device-code-1",
      payload,
      10,
    );

    assert.deepEqual(
      await codes.findByUserCode("ABCD-1234"),
      payload,
    );
    assert.deepEqual(
      await codes.findByUid("device-uid"),
      payload,
    );

    nowMs += 11_000;

    assert.equal(
      await codes.find("device-code-1"),
      undefined,
    );
    assert.equal(
      await codes.findByUserCode("ABCD-1234"),
      undefined,
    );
    assert.equal(
      await codes.findByUid("device-uid"),
      undefined,
    );
  } finally {
    store.close();
    await rm(temp, {
      recursive: true,
      force: true,
    });
  }
});

test("SQLite adapter persists consume state without corrupting payload", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tether-auth-sqlite-"),
  );
  const databasePath = path.join(
    temp,
    "provider.sqlite",
  );
  let nowMs = 1_900_000_000_000;
  const store = createSqliteAdapter({
    databasePath,
    now: () => nowMs,
  });

  try {
    const codes: Adapter =
      new store.Adapter("AuthorizationCode");
    await codes.upsert(
      "code-1",
      {
        accountId: "account-1",
        grantId: "grant-1",
        codeChallenge: "challenge",
      },
      60,
    );

    nowMs += 2_000;
    await codes.consume("code-1");

    const consumed = await codes.find("code-1");
    assert.equal(
      consumed?.accountId,
      "account-1",
    );
    assert.equal(
      consumed?.grantId,
      "grant-1",
    );
    assert.equal(
      consumed?.codeChallenge,
      "challenge",
    );
    assert.equal(
      consumed?.consumed,
      Math.floor(nowMs / 1_000),
    );

    store.close();

    const reopened = createSqliteAdapter({
      databasePath,
      now: () => nowMs,
    });
    try {
      assert.equal(
        (
          await new reopened.Adapter(
            "AuthorizationCode",
          ).find("code-1")
        )?.consumed,
        Math.floor(nowMs / 1_000),
      );
    } finally {
      reopened.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // Already closed after the durability check.
    }
    await rm(temp, {
      recursive: true,
      force: true,
    });
  }
});

test("SQLite adapter isolates model ids and revokes a grant across models", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tether-auth-sqlite-"),
  );
  const store = createSqliteAdapter({
    databasePath: path.join(
      temp,
      "provider.sqlite",
    ),
  });

  try {
    const access: Adapter =
      new store.Adapter("AccessToken");
    const refresh: Adapter =
      new store.Adapter("RefreshToken");

    await access.upsert(
      "shared-id",
      {
        kind: "AccessToken",
        grantId: "grant-revoke",
      },
      3_600,
    );
    await refresh.upsert(
      "shared-id",
      {
        kind: "RefreshToken",
        grantId: "grant-revoke",
      },
      3_600,
    );
    await access.upsert(
      "keep-id",
      {
        grantId: "grant-keep",
      },
      3_600,
    );

    assert.equal(
      (await access.find("shared-id"))?.kind,
      "AccessToken",
    );
    assert.equal(
      (await refresh.find("shared-id"))?.kind,
      "RefreshToken",
    );

    await access.revokeByGrantId(
      "grant-revoke",
    );

    assert.equal(
      await access.find("shared-id"),
      undefined,
    );
    assert.equal(
      await refresh.find("shared-id"),
      undefined,
    );
    assert.ok(await access.find("keep-id"));
  } finally {
    store.close();
    await rm(temp, {
      recursive: true,
      force: true,
    });
  }
});

test("SQLite production adapter rejects in-memory storage", () => {
  assert.throws(
    () =>
      createSqliteAdapter({
        databasePath: ":memory:",
      }),
    /persistent file/i,
  );
});
