import assert from "node:assert/strict";
import {
  generateKeyPairSync,
} from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  TetherAuthDeploymentConfig,
} from "../src/cli-config.ts";
import {
  startTetherAuthProductionService,
} from "../src/production.ts";

test("production auth service composes SQLite, device-login bridge, provider, and lifecycle", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tether-auth-production-"),
  );
  const databasePath = path.join(
    temp,
    "provider.sqlite",
  );
  const { privateKey } =
    generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
  const jwk = privateKey.export({
    format: "jwk",
  }) as JsonWebKey;
  const deployment:
    TetherAuthDeploymentConfig = {
      issuer:
        "https://auth.example.com/",
      resource:
        "https://relay.example.com/mcp",
      interactionBasePath:
        "/interaction",
      databasePath,
      jwks: {
        keys: [
          {
            ...jwk,
            kid: "production-test-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      },
      relay: {
        url: "https://relay.example.com",
        bridgeToken: "b".repeat(48),
        allowInsecureLocalhost: false,
      },
    };

  const service =
    await startTetherAuthProductionService({
      deployment,
      listen: {
        host: "127.0.0.1",
        port: 0,
      },
      allowInsecureLocalhost: true,
    });

  try {
    const health = await fetch(
      `${service.address.url}/healthz`,
    );
    assert.equal(health.status, 200);

    const discovery = await fetch(
      `${service.address.url}/.well-known/openid-configuration`,
    );
    assert.equal(discovery.status, 200);
    const metadata =
      await discovery.json() as Record<string, unknown>;
    assert.equal(
      metadata.issuer,
      deployment.issuer,
    );
    assert.deepEqual(
      metadata.code_challenge_methods_supported,
      ["S256"],
    );
    // A loopback test request has an HTTP origin, but the public HTTPS
    // discovery request arrives through a trusted same-host reverse proxy.
    // Simulate only the forwarded origin; never expose the listener itself.
    const proxiedDiscovery = await fetch(
      `${service.address.url}/.well-known/openid-configuration`,
      {
        headers: {
          "x-forwarded-host": new URL(deployment.issuer).host,
          "x-forwarded-proto": "https",
        },
      },
    );
    assert.equal(proxiedDiscovery.status, 200);
    const proxiedMetadata =
      await proxiedDiscovery.json() as Record<string, unknown>;
    assert.equal(proxiedMetadata.issuer, deployment.issuer);

    for (const field of [
      "authorization_endpoint",
      "token_endpoint",
      "jwks_uri",
      "registration_endpoint",
    ]) {
      const value = proxiedMetadata[field];
      assert.ok(
        typeof value === "string" &&
          value.startsWith(deployment.issuer),
        `OIDC metadata ${field} must be under ${deployment.issuer}; received ${JSON.stringify(value)}`,
      );
    }
  } finally {
    await service.close();
    await service.closed;
    await rm(temp, {
      recursive: true,
      force: true,
    });
  }
});

test("auth package exposes tether-auth executable", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    ),
  ) as {
    bin?: Record<string, string>;
  };

  assert.equal(
    manifest.bin?.["tether-auth"],
    "./dist/cli.js",
  );
});
