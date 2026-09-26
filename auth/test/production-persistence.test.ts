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
