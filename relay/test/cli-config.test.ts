import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadClientAuth,
  loadStaticClientCredentials,
  parseRelayArgs,
} from "../src/cli-config.ts";

test("CLI config uses token environment references instead of persisted bearer tokens", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "tether-relay-cli-"),
  );
  const authPath = path.join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      clients: [
        {
          token_env: "TETHERPLANE_TEST_TOKEN",
          account_id: "account-a",
          client_id: "client-a",
          principal_id: "human:account-a",
        },
      ],
    }),
    "utf8",
  );

  try {
    const credentials = await loadStaticClientCredentials(
      authPath,
      {
        TETHERPLANE_TEST_TOKEN: "runtime-only-secret",
      },
    );
    assert.deepEqual(credentials, [
      {
        token: "runtime-only-secret",
        accountId: "account-a",
        clientId: "client-a",
        principalId: "human:account-a",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auth config rejects embedded raw tokens and missing token environment variables", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "tether-relay-cli-invalid-"),
  );
  const rawTokenPath = path.join(dir, "raw-token.json");
  const missingEnvPath = path.join(dir, "missing-env.json");
  await writeFile(
    rawTokenPath,
    JSON.stringify({
      clients: [
        {
          token: "must-not-be-persisted",
          token_env: "TOKEN_ENV",
          account_id: "account-a",
          client_id: "client-a",
          principal_id: "human:account-a",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    missingEnvPath,
    JSON.stringify({
      clients: [
        {
          token_env: "MISSING_TOKEN",
          account_id: "account-a",
          client_id: "client-a",
          principal_id: "human:account-a",
        },
      ],
    }),
    "utf8",
  );

  try {
    await assert.rejects(
      loadStaticClientCredentials(rawTokenPath, {
        TOKEN_ENV: "runtime-secret",
      }),
      /raw token|token_env/i,
    );
    await assert.rejects(
      loadStaticClientCredentials(missingEnvPath, {}),
      /MISSING_TOKEN/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI requires auth config and either TLS pair or explicit insecure loopback mode", () => {
  assert.throws(
    () => parseRelayArgs([]),
    /auth-config/i,
  );
  assert.throws(
    () =>
      parseRelayArgs([
        "--auth-config",
        "auth.json",
        "--tls-cert",
        "cert.pem",
      ]),
    /tls-key/i,
  );
  assert.throws(
    () =>
      parseRelayArgs([
        "--auth-config",
        "auth.json",
      ]),
    /TLS|insecure/i,
  );

  const insecure = parseRelayArgs([
    "--auth-config",
    "auth.json",
    "--state-file",
    "devices.json",
    "--host",
    "127.0.0.1",
    "--port",
    "9876",
    "--allow-insecure-localhost",
  ]);
  assert.equal(insecure.host, "127.0.0.1");
  assert.equal(insecure.port, 9876);
  assert.equal(insecure.authConfig, "auth.json");
  assert.equal(insecure.stateFile, "devices.json");
  assert.equal(insecure.allowInsecureLocalhost, true);

  const tls = parseRelayArgs([
    "--auth-config",
    "auth.json",
    "--tls-cert",
    "cert.pem",
    "--tls-key",
    "key.pem",
  ]);
  assert.equal(tls.tlsCert, "cert.pem");
  assert.equal(tls.tlsKey, "key.pem");
  assert.equal(tls.allowInsecureLocalhost, false);
});


test("OIDC auth config loads device-login bridge value only through environment reference", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "tether-relay-auth-bridge-"),
  );
  const authPath = path.join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      oidc: {
        issuer: "https://identity.example/",
        audience: "https://relay.example/mcp",
        jwksUri: "https://identity.example/jwks",
        scopes: ["tetherplane:access"],
        identity: {
          strategy: "subject",
          principalPrefix: "human:",
        },
      },
      deviceLoginBridge: {
        tokenEnv: "TETHERPLANE_AUTH_BRIDGE_VALUE",
      },
    }),
    "utf8",
  );

  try {
    const loaded = await loadClientAuth(
      authPath,
      {
        TETHERPLANE_AUTH_BRIDGE_VALUE:
          "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      },
    );
    assert.equal(
      loaded.authLoginBridgeToken,
      "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    );

    await assert.rejects(
      loadClientAuth(authPath, {}),
      /TETHERPLANE_AUTH_BRIDGE_VALUE/,
    );

    await writeFile(
      authPath,
      JSON.stringify({
        oidc: {
          issuer: "https://identity.example/",
          audience: "https://relay.example/mcp",
          jwksUri: "https://identity.example/jwks",
          scopes: ["tetherplane:access"],
          identity: {
            strategy: "subject",
            principalPrefix: "human:",
          },
        },
        deviceLoginBridge: {
          token: "RAW_VALUE_MUST_NOT_BE_PERSISTED",
        },
      }),
      "utf8",
    );
    await assert.rejects(
      loadClientAuth(authPath, {
        TETHERPLANE_AUTH_BRIDGE_VALUE:
          "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      }),
      /bridge|token|config/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
