import assert from "node:assert/strict";
import {
  generateKeyPairSync,
} from "node:crypto";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  startTetherAuthProductionService,
} from "../src/production.ts";

const ISSUER =
  "https://auth.example.com/";
const RESOURCE =
  "https://relay.example.com/mcp";

test("production auth DCR metadata and registered client survive restart", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tether-auth-dcr-"),
  );
  const databasePath = path.join(
    temp,
    "provider.sqlite",
  );
  const jwks = testJwks();
  let first:
    | Awaited<
        ReturnType<
          typeof startTetherAuthProductionService
        >
      >
    | undefined;
  let second:
    | Awaited<
        ReturnType<
          typeof startTetherAuthProductionService
        >
      >
    | undefined;

  try {
    first = await startService(
      databasePath,
      jwks,
    );

    const discovery = await fetch(
      `${first.address.url}/.well-known/openid-configuration`,
    );
    assert.equal(discovery.status, 200);
    const metadata =
      await discovery.json() as Record<string, unknown>;

    assert.equal(metadata.issuer, ISSUER);
    assert.deepEqual(
      metadata.code_challenge_methods_supported,
      ["S256"],
    );
    assert.match(
      String(metadata.registration_endpoint ?? ""),
      /\/reg$/,
    );
    assert.ok(
      Array.isArray(
        metadata.grant_types_supported,
      ) &&
        metadata.grant_types_supported.includes(
          "authorization_code",
        ) &&
        metadata.grant_types_supported.includes(
          "refresh_token",
        ),
    );

    const registration = await fetch(
      `${first.address.url}/reg`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          redirect_uris: [
            "https://client.example/oauth/callback",
          ],
          grant_types: [
            "authorization_code",
            "refresh_token",
          ],
          response_types: ["code"],
          token_endpoint_auth_method:
            "none",
          client_name:
            "Tetherplane ChatGPT acceptance fixture",
        }),
      },
    );
    assert.equal(registration.status, 201);
    const registered =
      await registration.json() as Record<
        string,
        unknown
      >;
    const clientId = registered.client_id;
    assert.equal(
      typeof clientId,
      "string",
    );
    assert.equal(
      registered.token_endpoint_auth_method,
      "none",
    );

    assert.ok(
      await first.provider.Client.find(
        clientId as string,
      ),
    );

    await first.close();
    first = undefined;

    second = await startService(
      databasePath,
      jwks,
    );
    const persisted =
      await second.provider.Client.find(
        clientId as string,
      );
    assert.ok(persisted);
    assert.equal(
      persisted.clientId,
      clientId,
    );
    assert.deepEqual(
      persisted.redirectUris,
      [
        "https://client.example/oauth/callback",
      ],
    );
  } finally {
    await first?.close();
    await second?.close();
    await rm(temp, {
      recursive: true,
      force: true,
    });
  }
});

test("production auth grant and refresh token survive restart and revoke together", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tether-auth-refresh-"),
  );
  const databasePath = path.join(
    temp,
    "provider.sqlite",
  );
  const jwks = testJwks();
  let first:
    | Awaited<
        ReturnType<
          typeof startTetherAuthProductionService
        >
      >
    | undefined;
  let second:
    | Awaited<
        ReturnType<
          typeof startTetherAuthProductionService
        >
      >
    | undefined;

  try {
    first = await startService(
      databasePath,
      jwks,
    );

    const registration = await fetch(
      `${first.address.url}/reg`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          redirect_uris: [
            "https://client.example/oauth/callback",
          ],
          grant_types: [
            "authorization_code",
            "refresh_token",
          ],
          response_types: ["code"],
          token_endpoint_auth_method:
            "none",
        }),
      },
    );
    assert.equal(registration.status, 201);
    const registered =
      await registration.json() as Record<
        string,
        unknown
      >;
    const clientId =
      registered.client_id as string;
    const client =
      await first.provider.Client.find(
        clientId,
      );
    assert.ok(client);

    const grant =
      new first.provider.Grant({
        accountId: "account-1",
        clientId,
      });
    grant.addOIDCScope(
      "openid offline_access",
    );
    grant.addResourceScope(
      RESOURCE,
      "tetherplane:access",
    );
    const grantId = await grant.save();

    const refresh =
      new first.provider.RefreshToken({
        client,
        accountId: "account-1",
        resource: RESOURCE,
        scope:
          "openid offline_access tetherplane:access",
        grantId,
        gty: "authorization_code",
      });
    const refreshId =
      await refresh.save();

    await first.close();
    first = undefined;

    second = await startService(
      databasePath,
      jwks,
    );

    const persistedGrant =
      await second.provider.Grant.find(
        grantId,
      );
    const persistedRefresh =
      await second.provider.RefreshToken.find(
        refreshId,
      );

    assert.ok(persistedGrant);
    assert.ok(persistedRefresh);
    assert.equal(
      persistedRefresh.accountId,
      "account-1",
    );
    assert.equal(
      persistedRefresh.grantId,
      grantId,
    );

    await second.provider.RefreshToken
      .revokeByGrantId(grantId);

    assert.equal(
      await second.provider.RefreshToken.find(
        refreshId,
      ),
      undefined,
    );
    assert.equal(
      await second.provider.Grant.find(
        grantId,
      ),
      undefined,
    );
  } finally {
    await first?.close();
    await second?.close();
    await rm(temp, {
      recursive: true,
      force: true,
    });
  }
});

test("legacy generic access scopes never become a new unbound MCP grant after upgrade", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tether-auth-legacy-"));
  const databasePath = path.join(temp, "provider.sqlite");
  const jwks = testJwks();
  let first: Awaited<ReturnType<typeof startTetherAuthProductionService>> | undefined;
  let second: Awaited<ReturnType<typeof startTetherAuthProductionService>> | undefined;

  try {
    first = await startService(databasePath, jwks);
    const registration = await fetch(first.address.url + "/reg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(registration.status, 201);
    const created = await registration.json() as { client_id: string };
    const clientId = created.client_id;
    const client = await first.provider.Client.find(clientId);
    assert.ok(client);

    const legacyGrants: Record<string, {grantId: string; refreshId: string}> = {};
    for (const boundToResource of [true, false]) {
      // Both cases simulate pre-upgrade persisted generic OIDC grants.
      // Only the first had the canonical RFC8707 resource authorization.
      const grant = new first.provider.Grant({accountId: "account-1", clientId});
      grant.addOIDCScope("openid offline_access tetherplane:access");
      if (boundToResource) {
        grant.addResourceScope(RESOURCE, "tetherplane:access");
      }
      const grantId = await grant.save();
      const refresh = new first.provider.RefreshToken({
        client,
        accountId: "account-1",
        ...(boundToResource ? {resource: RESOURCE} : {}),
        scope: "openid offline_access tetherplane:access",
        grantId,
        gty: "authorization_code",
      });
      const refreshId = await refresh.save();
      legacyGrants[boundToResource ? "bound" : "unbound"] = {grantId, refreshId};
    }

    await first.close();
    first = undefined;
    second = await startService(databasePath, jwks);
    assert.ok(await second.provider.Client.find(clientId), "Original DCR client must survive the upgrade");
    const bound = legacyGrants["bound"]!;
    const unbound = legacyGrants["unbound"]!;
    assert.ok(await second.provider.Grant.find(bound.grantId), "Do not silently delete valid grants");
    assert.ok(await second.provider.RefreshToken.find(bound.refreshId), "Do not silently delete valid refresh state");
    assert.ok(await second.provider.Grant.find(unbound.grantId), "Inspection of legacy state must not mutate it");
    // A model accessor is not guaranteed to expose persisted scope fields.
    // Inspect only the synthetic stored grant to prove that this test
    // actually carries the old generic OIDC scope across the restart.
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = db.prepare("SELECT payload FROM oidc_objects WHERE model = 'Grant' AND id = ?").get(unbound.grantId) as {payload?: string} | undefined;
      assert.equal(typeof row?.payload, "string");
      assert.equal(row!.payload!.includes("tetherplane:access"), true,
        "Legacy test fixture must retain the old generic OIDC access scope");
    } finally {
      db.close();
    }
    assert.ok(await second.provider.RefreshToken.find(unbound.refreshId));

    const redeem = async (token: string) =>
      fetch(second!.address.url + "/token", {
        method: "POST",
        headers: {"content-type": "application/x-www-form-urlencoded"},
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token,
          client_id: clientId,
          resource: RESOURCE,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });

    const allowed = await redeem(bound.refreshId);
    assert.equal(allowed.status, 200, "Existing resource-bound refresh grant must keep working");
    const allowedData = await allowed.json() as {access_token?: string};
    assert.equal(typeof allowedData.access_token, "string");
    const payload = JSON.parse(Buffer.from(allowedData.access_token!.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    assert.deepEqual(payload.aud, RESOURCE, "Legacy client must not receive a different token audience");
    assert.equal(payload.scope, "tetherplane:access", "Legacy generic scope must not expand authorization");

    const denied = await redeem(unbound.refreshId);
    assert.notEqual(denied.status, 200, "Generic OIDC-only legacy grants cannot mint MCP resource tokens");
    assert.ok(denied.status >= 400 && denied.status < 500);
  } finally {
    await first?.close();
    await second?.close();
    await rm(temp, {recursive: true, force: true});
  }
});

async function startService(
  databasePath: string,
  jwks: {
    keys: Array<Record<string, unknown>>;
  },
) {
  return startTetherAuthProductionService({
    deployment: {
      issuer: ISSUER,
      resource: RESOURCE,
      interactionBasePath:
        "/interaction",
      databasePath,
      jwks,
      relay: {
        url: "https://relay.example.com",
        bridgeToken: "x".repeat(48),
        allowInsecureLocalhost: false,
      },
    },
    listen: {
      host: "127.0.0.1",
      port: 0,
    },
    allowInsecureLocalhost: true,
  });
}

function testJwks(): {
  keys: Array<Record<string, unknown>>;
} {
  const { privateKey } =
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
  return {
    keys: [
      {
        ...privateKey.export({
          format: "jwk",
        }),
        kid: "integration-key",
        alg: "RS256",
        use: "sig",
      },
    ],
  };
}
