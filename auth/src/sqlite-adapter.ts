import {
  chmodSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import {
  DatabaseSync,
  type StatementSync,
} from "node:sqlite";

import type {
  Adapter,
  AdapterConstructor,
  AdapterPayload,
} from "oidc-provider";

type StoredRow = {
  payload: string;
  expires_at: number | null;
  consumed_at: number | null;
};

export type TetherAuthSqliteAdapter = {
  Adapter: AdapterConstructor;
  databasePath: string;
  close(): void;
};

export function createSqliteAdapter(options: {
  databasePath: string;
  now?: () => number;
}): TetherAuthSqliteAdapter {
  if (
    typeof options.databasePath !== "string" ||
    !options.databasePath.trim() ||
    options.databasePath === ":memory:"
  ) {
    throw new Error(
      "SQLite auth adapter requires a persistent file path",
    );
  }

  const databasePath = path.resolve(
    options.databasePath,
  );
  const parent = path.dirname(databasePath);
  mkdirSync(parent, {
    recursive: true,
    mode: 0o700,
  });

  const database = new DatabaseSync(
    databasePath,
  );
  if (process.platform !== "win32") {
    chmodSync(databasePath, 0o600);
  }

  database.exec(
    [
      "PRAGMA journal_mode = WAL;",
      "PRAGMA synchronous = NORMAL;",
      "PRAGMA busy_timeout = 5000;",
      "",
      "CREATE TABLE IF NOT EXISTS oidc_objects (",
      "  model TEXT NOT NULL,",
      "  id TEXT NOT NULL,",
      "  payload TEXT NOT NULL,",
      "  expires_at INTEGER,",
      "  consumed_at INTEGER,",
      "  user_code TEXT,",
      "  uid TEXT,",
      "  grant_id TEXT,",
      "  PRIMARY KEY (model, id)",
      ") STRICT;",
      "",
      "CREATE INDEX IF NOT EXISTS idx_oidc_expires_at",
      "  ON oidc_objects (expires_at)",
      "  WHERE expires_at IS NOT NULL;",
      "",
      "CREATE INDEX IF NOT EXISTS idx_oidc_user_code",
      "  ON oidc_objects (model, user_code)",
      "  WHERE user_code IS NOT NULL;",
      "",
      "CREATE INDEX IF NOT EXISTS idx_oidc_uid",
      "  ON oidc_objects (model, uid)",
      "  WHERE uid IS NOT NULL;",
      "",
      "CREATE INDEX IF NOT EXISTS idx_oidc_grant_id",
      "  ON oidc_objects (grant_id)",
      "  WHERE grant_id IS NOT NULL;",
    ].join("\n"),
  );

  const now =
    options.now ?? Date.now;
  let closed = false;

  const upsert = database.prepare(
    [
      "INSERT INTO oidc_objects (",
      "  model,",
      "  id,",
      "  payload,",
      "  expires_at,",
      "  consumed_at,",
      "  user_code,",
      "  uid,",
      "  grant_id",
      ") VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
      "ON CONFLICT (model, id) DO UPDATE SET",
      "  payload = excluded.payload,",
      "  expires_at = excluded.expires_at,",
      "  consumed_at = NULL,",
      "  user_code = excluded.user_code,",
      "  uid = excluded.uid,",
      "  grant_id = excluded.grant_id",
    ].join("\n"),
  );
  const findById = database.prepare(
    [
      "SELECT payload, expires_at, consumed_at",
      "FROM oidc_objects",
      "WHERE model = ?",
      "  AND id = ?",
      "  AND (expires_at IS NULL OR expires_at > ?)",
      "LIMIT 1",
    ].join("\n"),
  );
  const findByUserCode = database.prepare(
    [
      "SELECT payload, expires_at, consumed_at",
      "FROM oidc_objects",
      "WHERE model = ?",
      "  AND user_code = ?",
      "  AND (expires_at IS NULL OR expires_at > ?)",
      "LIMIT 1",
    ].join("\n"),
  );
  const findByUid = database.prepare(
    [
      "SELECT payload, expires_at, consumed_at",
      "FROM oidc_objects",
      "WHERE model = ?",
      "  AND uid = ?",
      "  AND (expires_at IS NULL OR expires_at > ?)",
      "LIMIT 1",
    ].join("\n"),
  );
  const consume = database.prepare(
    [
      "UPDATE oidc_objects",
      "SET consumed_at = ?",
      "WHERE model = ?",
      "  AND id = ?",
      "  AND (expires_at IS NULL OR expires_at > ?)",
    ].join("\n"),
  );
  const destroy = database.prepare(
    [
      "DELETE FROM oidc_objects",
      "WHERE model = ?",
      "  AND id = ?",
    ].join("\n"),
  );
  const revokeGrant = database.prepare(
    [
      "DELETE FROM oidc_objects",
      "WHERE grant_id = ?",
    ].join("\n"),
  );
  const purgeExpired = database.prepare(
    [
      "DELETE FROM oidc_objects",
      "WHERE expires_at IS NOT NULL",
      "  AND expires_at <= ?",
    ].join("\n"),
  );

  function assertOpen(): void {
    if (closed) {
      throw new Error(
        "SQLite auth adapter is closed",
      );
    }
  }

  function epochSeconds(): number {
    return Math.floor(now() / 1_000);
  }

  function purge(): number {
    const current = epochSeconds();
    purgeExpired.run(current);
    return current;
  }

  function read(
    statement: StatementSync,
    ...bindings: Array<string | number>
  ): AdapterPayload | undefined {
    assertOpen();
    const current = purge();
    const row = statement.get(
      ...bindings,
      current,
    ) as StoredRow | undefined;
    if (!row) {
      return undefined;
    }

    const payload =
      JSON.parse(row.payload) as unknown;
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw new Error(
        "SQLite auth adapter payload is corrupt",
      );
    }

    const result = {
      ...(payload as AdapterPayload),
    };
    if (row.consumed_at !== null) {
      result.consumed = row.consumed_at;
    }
    return result;
  }

  class SqliteAdapter implements Adapter {
    readonly #model: string;

    constructor(model: string) {
      if (
        typeof model !== "string" ||
        !model.trim()
      ) {
        throw new Error(
          "SQLite auth adapter model is invalid",
        );
      }
      this.#model = model;
    }

    async upsert(
      id: string,
      payload: AdapterPayload,
      expiresIn?: number,
    ): Promise<void> {
      assertOpen();
      const current = purge();
      const expiresAt =
        expiresIn === undefined
          ? null
          : current +
            Math.max(
              0,
              Math.floor(expiresIn),
            );

      upsert.run(
        this.#model,
        id,
        JSON.stringify(payload),
        expiresAt,
        stringField(
          payload.userCode,
        ),
        stringField(payload.uid),
        this.#model === "Grant"
          ? id
          : stringField(
              payload.grantId,
            ),
      );
    }

    async find(
      id: string,
    ): Promise<AdapterPayload | undefined> {
      return read(
        findById,
        this.#model,
        id,
      );
    }

    async findByUserCode(
      userCode: string,
    ): Promise<AdapterPayload | undefined> {
      return read(
        findByUserCode,
        this.#model,
        userCode,
      );
    }

    async findByUid(
      uid: string,
    ): Promise<AdapterPayload | undefined> {
      return read(
        findByUid,
        this.#model,
        uid,
      );
    }

    async consume(
      id: string,
    ): Promise<void> {
      assertOpen();
      const current = purge();
      consume.run(
        current,
        this.#model,
        id,
        current,
      );
    }

    async destroy(
      id: string,
    ): Promise<void> {
      assertOpen();
      purge();
      destroy.run(
        this.#model,
        id,
      );
    }

    async revokeByGrantId(
      grantId: string,
    ): Promise<void> {
      assertOpen();
      purge();
      revokeGrant.run(grantId);
    }
  }

  return {
    Adapter: SqliteAdapter,
    databasePath,
    close() {
      if (closed) {
        return;
      }
      closed = true;
      database.close();
    },
  };
}

function stringField(
  value: unknown,
): string | null {
  return typeof value === "string" &&
    value.length > 0
    ? value
    : null;
}
