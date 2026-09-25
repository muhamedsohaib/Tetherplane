import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  StaticClientAuthenticator,
} from "../src/auth/static-auth.ts";
import { RelayServer } from "../src/server.ts";
import { hashDeviceCredential } from "../src/devices/registry.ts";

test("relay server permits explicit plaintext loopback development mode", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "tether-relay-server-"),
  );
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    authenticator: auth(),
    allowInsecureLocalhost: true,
  });

  try {
    const address = await relay.listen({
      host: "127.0.0.1",
      port: 0,
    });
    assert.match(address.httpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(address.deviceWsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/device$/);
    assert.equal(relay.isSecure, false);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("relay exposes minimal unauthenticated liveness and readiness probes", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "tether-relay-health-"),
  );
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    authenticator: auth(),
    allowInsecureLocalhost: true,
  });

  try {
    const address = await relay.listen({
      host: "127.0.0.1",
      port: 0,
    });

    const health = await fetch(`${address.httpUrl}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("content-type"), "application/json");
    assert.deepEqual(await health.json(), { status: "ok" });

    const ready = await fetch(`${address.httpUrl}/readyz`, {
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get("content-type"), "application/json");
    assert.deepEqual(await ready.json(), { status: "ready" });
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("plaintext relay refuses production or non-loopback binding", async () => {
  const relay = await RelayServer.create({
    authenticator: auth(),
    allowInsecureLocalhost: true,
  });

  try {
    await assert.rejects(
      relay.listen({ host: "0.0.0.0", port: 0 }),
      /TLS|loopback/i,
    );
  } finally {
    await relay.close();
  }

  const strictRelay = await RelayServer.create({
    authenticator: auth(),
  });
  try {
    await assert.rejects(
      strictRelay.listen({ host: "127.0.0.1", port: 0 }),
      /TLS|insecure/i,
    );
  } finally {
    await strictRelay.close();
  }
});

function auth(): StaticClientAuthenticator {
  return new StaticClientAuthenticator([
    {
      token: "relay-server-test-token",
      accountId: "account-a",
      clientId: "client-a",
      principalId: "human:account-a",
    },
  ]);
}


test("relay server attaches device-login bridge with service/device auth separation", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "tether-relay-auth-login-"),
  );
  const bridgeValue =
    "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    authenticator: auth(),
    allowInsecureLocalhost: true,
    authLoginBridgeToken: bridgeValue,
  });

  const deviceValue =
    "TEST_DEVICE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const pendingPair = await relay.registry.startPairing({
    deviceId: "Leno",
    credentialHash: hashDeviceCredential(deviceValue),
  });
  await relay.registry.approvePairing({
    accountId: "account-a",
    userCode: pendingPair.userCode,
  });

  try {
    const address = await relay.listen({
      host: "127.0.0.1",
      port: 0,
    });

    const started = await fetch(
      `${address.httpUrl}/auth/device-login/start`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridgeValue}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          interactionUid: "interaction_123",
        }),
      },
    );
    assert.equal(started.status, 200);
    const startedBody = await started.json() as {
      userCode: string;
    };

    const approved = await fetch(
      `${address.httpUrl}/auth/device-login/approve`,
      {
        method: "POST",
        headers: {
          authorization: `Device ${deviceValue}`,
          "x-tetherplane-device-id": "Leno",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          interactionUid: "interaction_123",
          userCode: startedBody.userCode,
        }),
      },
    );
    assert.equal(approved.status, 200);

    const consumed = await fetch(
      `${address.httpUrl}/auth/device-login/consume`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bridgeValue}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          interactionUid: "interaction_123",
          userCode: startedBody.userCode,
        }),
      },
    );
    assert.equal(consumed.status, 200);
    assert.deepEqual(await consumed.json(), {
      accountId: "account-a",
    });
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});
