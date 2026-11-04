import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  StaticClientAuthenticator,
} from "../src/auth/static-auth.ts";
import {
  DeviceRegistry,
  hashDeviceCredential,
} from "../src/devices/registry.ts";
import {
  RelayControlHttpGateway,
} from "../src/devices/control-http.ts";

test("HTTP pairing requires human approval and lists only the owning account device", async () => {
  const registry = await DeviceRegistry.open();
  const authenticator = auth();
  const disconnected: string[] = [];
  const gateway = new RelayControlHttpGateway({
    registry,
    authenticator,
    disconnectDevice: (deviceId) => disconnected.push(deviceId),
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const base = baseUrl(server);

  try {
    const secret = "device-secret-for-http-pairing";
    const started = await jsonRequest(base, "/pair/start", {
      method: "POST",
      body: {
        deviceId: "Leno",
        credentialHash: hashDeviceCredential(secret),
      },
    });
    assert.equal(started.status, 200);
    assert.match(
      String(started.body.userCode),
      /^[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    );

    assert.equal(
      await registry.authenticateDevice("Leno", secret),
      null,
    );

    const anonymousPreview = await jsonRequest(base, "/pair/preview", {
      method: "POST",
      body: { userCode: started.body.userCode },
    });
    assert.equal(anonymousPreview.status, 401);
    const preview = await jsonRequest(base, "/pair/preview", {
      method: "POST", token: "token-a",
      body: { userCode: started.body.userCode },
    });
    assert.equal(preview.status, 200);
    assert.deepEqual(Object.keys(preview.body).sort(), ["deviceId", "expiresAt"]);
    assert.equal(preview.body.deviceId, "Leno");
    assert.equal(preview.body.expiresAt, started.body.expiresAt);
    assert.doesNotMatch(JSON.stringify(preview.body), /credentialHash|device-secret/);
    assert.equal(await registry.authenticateDevice("Leno", secret), null);

    const approved = await jsonRequest(base, "/pair/approve", {
      method: "POST",
      token: "token-a",
      body: { userCode: started.body.userCode },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.accountId, "account-a");
    const consumedPreview = await jsonRequest(base, "/pair/preview", {
      method: "POST", token: "token-a",
      body: { userCode: started.body.userCode },
    });
    assert.equal(consumedPreview.status, 400);
    assert.equal(
      await registry.authenticateDevice("Leno", secret),
      "account-a",
    );

    const accountA = await jsonRequest(base, "/devices", {
      method: "GET",
      token: "token-a",
    });
    assert.equal(accountA.status, 200);
    assert.deepEqual(
      (accountA.body.devices as Array<{ deviceId: string }>).map(
        (device) => device.deviceId,
      ),
      ["Leno"],
    );

    const accountB = await jsonRequest(base, "/devices", {
      method: "GET",
      token: "token-b",
    });
    assert.equal(accountB.status, 200);
    assert.deepEqual(accountB.body.devices, []);
    assert.deepEqual(disconnected, []);
  } finally {
    gateway.close();
    await closeServer(server);
  }
});

test("HTTP revocation is account-scoped, disconnects live device, and invalidates credential", async () => {
  const registry = await DeviceRegistry.open();
  const secret = "device-secret-for-http-revoke";
  const pending = await registry.startPairing({
    deviceId: "Leno",
    credentialHash: hashDeviceCredential(secret),
  });
  await registry.approvePairing({
    accountId: "account-a",
    userCode: pending.userCode,
  });

  const disconnected: string[] = [];
  const gateway = new RelayControlHttpGateway({
    registry,
    authenticator: auth(),
    disconnectDevice: (deviceId) => disconnected.push(deviceId),
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const base = baseUrl(server);

  try {
    const denied = await jsonRequest(
      base,
      "/devices/Leno/revoke",
      {
        method: "POST",
        token: "token-b",
        body: {},
      },
    );
    assert.equal(denied.status, 403);
    assert.equal(
      await registry.authenticateDevice("Leno", secret),
      "account-a",
    );
    assert.deepEqual(disconnected, []);

    const revoked = await jsonRequest(
      base,
      "/devices/Leno/revoke",
      {
        method: "POST",
        token: "token-a",
        body: {},
      },
    );
    assert.equal(revoked.status, 200);
    assert.notEqual(revoked.body.revokedAt, null);
    assert.deepEqual(disconnected, ["Leno"]);
    assert.equal(
      await registry.authenticateDevice("Leno", secret),
      null,
    );
  } finally {
    gateway.close();
    await closeServer(server);
  }
});

test("approval and device management endpoints reject missing bearer identity", async () => {
  const registry = await DeviceRegistry.open();
  const gateway = new RelayControlHttpGateway({
    registry,
    authenticator: auth(),
    disconnectDevice: () => undefined,
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const base = baseUrl(server);

  try {
    const approval = await jsonRequest(base, "/pair/approve", {
      method: "POST",
      body: { userCode: "AAAA-BBBB" },
    });
    assert.equal(approval.status, 401);

    const devices = await jsonRequest(base, "/devices", {
      method: "GET",
    });
    assert.equal(devices.status, 401);
  } finally {
    gateway.close();
    await closeServer(server);
  }
});

function auth(): StaticClientAuthenticator {
  return new StaticClientAuthenticator([
    {
      token: "token-a",
      accountId: "account-a",
      clientId: "client-a",
      principalId: "human:account-a",
    },
    {
      token: "token-b",
      accountId: "account-b",
      clientId: "client-b",
      principalId: "human:account-b",
    },
  ]);
}

async function jsonRequest(
  base: string,
  pathname: string,
  options: {
    method: "GET" | "POST";
    token?: string;
    body?: Record<string, unknown>;
  },
): Promise<{
  status: number;
  body: Record<string, any>;
}> {
  const response = await fetch(base + pathname, {
    method: options.method,
    headers: {
      accept: "application/json",
      ...(options.body
        ? { "content-type": "application/json" }
        : {}),
      ...(options.token
        ? { authorization: `Bearer ${options.token}` }
        : {}),
    },
    ...(options.body
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text
      ? (JSON.parse(text) as Record<string, any>)
      : {},
  };
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
}

function baseUrl(
  server: ReturnType<typeof createServer>,
): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}


test("owner preview and approval share an authenticated short-code rate limit", async () => {
  const registry = await DeviceRegistry.open();
  const secret = "throttled-approval-device-credential";
  const pairing = await registry.startPairing({
    deviceId: "ReviewThrottle",
    credentialHash: hashDeviceCredential(secret),
  });
  const gateway = new RelayControlHttpGateway({
    registry,
    authenticator: auth(),
    disconnectDevice: () => undefined,
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const base = baseUrl(server);
  try {
    for (let i = 0; i < 12; i++) {
      const denied = await jsonRequest(base, "/pair/preview", {
        method: "POST", token: "token-a",
        body: { userCode: "AAAA-0000" },
      });
      assert.equal(denied.status, 400);
    }
    // Even a correct short code cannot bypass a budget consumed by guesses.
    const blocked = await jsonRequest(base, "/pair/approve", {
      method: "POST", token: "token-a",
      body: { userCode: pairing.userCode },
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, "rate_limited");
    assert.equal(await registry.authenticateDevice("ReviewThrottle", secret), null);
    // A valid request from another already-authenticated account can still
    // review the code, but it does not approve or alter the device binding.
    const alternateReview = await jsonRequest(base, "/pair/preview", {
      method: "POST", token: "token-b",
      body: { userCode: pairing.userCode },
    });
    assert.equal(alternateReview.status, 200);
    assert.equal(await registry.authenticateDevice("ReviewThrottle", secret), null);
  } finally {
    gateway.close();
    await closeServer(server);
  }
});
