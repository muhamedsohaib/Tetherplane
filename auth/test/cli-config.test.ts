import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadTetherAuthDeploymentConfig,
  parseTetherAuthArgs,
} from "../src/cli-config.ts";

test("auth CLI requires explicit secure serving mode", () => {
  assert.throws(
    () =>
      parseTetherAuthArgs([
        "--config",
        "auth.json",
      ]),
    /TLS is required/i,
  );

  assert.deepEqual(
    parseTetherAuthArgs([
      "--config",
      "auth.json",
      "--allow-insecure-localhost",
    ]),
    {
      config: "auth.json",
      host: "127.0.0.1",
      port: 8790,
      allowInsecureLocalhost: true,
    },
  );

  assert.deepEqual(
    parseTetherAuthArgs([
      "--config",
      "auth.json",
      "--host",
      "0.0.0.0",
      "--port",
      "9443",
      "--tls-cert",
      "cert.pem",
      "--tls-key",
      "key.pem",
    ]),
    {
      config: "auth.json",
      host: "0.0.0.0",
      port: 9443,
      tlsCert: "cert.pem",
      tlsKey: "key.pem",
      allowInsecureLocalhost: false,
    },
  );

  assert.throws(
    () =>
      parseTetherAuthArgs([
        "--config",
        "auth.json",
        "--tls-cert",
        "cert.pem",
      ]),
    /provided together/i,
  );
});

test("auth deployment config loads file-backed state and secret references", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tether-auth-config-"),
  );
  const jwksFile = path.join(temp, "jwks.json");
  const databasePath = path.join(
    temp,
    "provider.sqlite",
  );
  const configFile = path.join(
    temp,
    "auth.json",
  );

  try {
    await writeFile(
      jwksFile,
      JSON.stringify({
        keys: [
          {
            kty: "RSA",
            kid: "auth-key-1",
            alg: "RS256",
            use: "sig",
            n: "example-modulus",
            e: "AQAB",
            d: "example-private",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      configFile,
      JSON.stringify({
        issuer: "https://auth.example.com/",
        resource: "https://relay.example.com/mcp",
        databasePath,
        jwksFile,
        relay: {
          url: "https://relay.example.com",
          bridgeTokenEnv:
            "TETHERPLANE_AUTH_BRIDGE_TOKEN",
        },
      }),
      "utf8",
    );

    const loaded =
      await loadTetherAuthDeploymentConfig(
        configFile,
        {
          TETHERPLANE_AUTH_BRIDGE_TOKEN:
            "a".repeat(48),
        },
      );

    assert.equal(
      loaded.issuer,
      "https://auth.example.com/",
    );
    assert.equal(
      loaded.resource,
      "https://relay.example.com/mcp",
    );
    assert.equal(
      loaded.databasePath,
      databasePath,
    );
    assert.deepEqual(
      loaded.jwks.keys.map((key) => key.kid),
      ["auth-key-1"],
    );
    assert.equal(
      loaded.relay.url,
      "https://relay.example.com",
    );
    assert.equal(
      loaded.relay.bridgeToken,
      "a".repeat(48),
    );
    assert.equal(
      loaded.relay.allowInsecureLocalhost,
      false,
    );
  } finally {
    await rm(temp, {
      recursive: true,
      force: true,
    });
  }
});

test("auth deployment config rejects embedded secrets and in-memory persistence", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tether-auth-config-"),
  );
  const configFile = path.join(
    temp,
    "auth.json",
  );

  try {
    await writeFile(
      configFile,
      JSON.stringify({
        issuer: "https://auth.example.com/",
        resource: "https://relay.example.com/mcp",
        databasePath: ":memory:",
        jwks: {
          keys: [],
        },
        relay: {
          url: "https://relay.example.com",
          bridgeToken: "secret",
        },
      }),
      "utf8",
    );

    await assert.rejects(
      loadTetherAuthDeploymentConfig(
        configFile,
        {},
      ),
      /unsupported auth config field|persistent file/i,
    );
  } finally {
    await rm(temp, {
      recursive: true,
      force: true,
    });
  }
});

test("auth deployment config requires referenced bridge credential", async () => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "tether-auth-config-"),
  );
  const jwksFile = path.join(temp, "jwks.json");
  const configFile = path.join(
    temp,
    "auth.json",
  );

  try {
    await writeFile(
      jwksFile,
      JSON.stringify({
        keys: [
          {
            kty: "RSA",
            kid: "auth-key-1",
            d: "private",
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      configFile,
      JSON.stringify({
        issuer: "https://auth.example.com/",
        resource: "https://relay.example.com/mcp",
        databasePath: path.join(
          temp,
          "provider.sqlite",
        ),
        jwksFile,
        relay: {
          url: "https://relay.example.com",
          bridgeTokenEnv:
            "TETHERPLANE_AUTH_BRIDGE_TOKEN",
        },
      }),
      "utf8",
    );

    await assert.rejects(
      loadTetherAuthDeploymentConfig(
        configFile,
        {},
      ),
      /bridge environment variable is missing/i,
    );
  } finally {
    await rm(temp, {
      recursive: true,
      force: true,
    });
  }
});
