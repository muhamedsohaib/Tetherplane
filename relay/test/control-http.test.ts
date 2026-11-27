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
import {
  DeviceRouter,
} from "../src/routing/device-router.ts";

test("HTTP pairing requires human approval and lists only the owning account device", async () => {
  const registry = await DeviceRegistry.open();
  const authenticator = auth();
  const disconnected: string[] = [];
  const gateway = new RelayControlHttpGateway({
    registry,
    authenticator,
    disconnectDevice: (deviceId) => disconnected.push(deviceId),
    router: new DeviceRouter({ registry }),
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

    const approved = await jsonRequest(base, "/pair/approve", {
      method: "POST",
      token: "token-a",
      body: { userCode: started.body.userCode },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.accountId, "account-a");
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
    router: new DeviceRouter({ registry }),
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
    router: new DeviceRouter({ registry }),
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

// ---- S4: owner policy Desired/Effective/Acknowledged ----

async function pairedDevice(
  registry: DeviceRegistry,
  deviceId: string,
  secret: string,
  accountId: string,
): Promise<void> {
  const pending = await registry.startPairing({
    deviceId,
    credentialHash: hashDeviceCredential(secret),
  });
  await registry.approvePairing({ accountId, userCode: pending.userCode });
}

test("owner sets desired policy and reads sync status per device", async () => {
  const registry = await DeviceRegistry.open();
  await pairedDevice(registry, "Leno", "device-secret-s4-owner", "account-a");
  const router = new DeviceRouter({
    registry,
  });
  const gateway = new RelayControlHttpGateway({
    registry,
    authenticator: auth(),
    disconnectDevice: () => undefined,
    router,
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const base = baseUrl(server);

  try {
    const set = await jsonRequest(base, "/devices/Leno/policy", {
      method: "POST",
      token: "token-a",
      body: { allowedCapabilities: ["device.status"] },
    });
    assert.equal(set.status, 200);
    assert.equal(set.body.version, 1);
    assert.equal(set.body.pushed, false);

    const sync = await jsonRequest(base, "/devices/Leno/policy", {
      method: "GET",
      token: "token-a",
    });
    assert.equal(sync.status, 200);
    assert.equal(sync.body.deviceId, "Leno");
    assert.equal(sync.body.online, false);
    assert.equal(sync.body.desiredVersion, 1);
    assert.deepEqual(sync.body.desiredCapabilities, ["device.status"]);
    assert.equal(sync.body.acknowledgedVersion, 0);
    assert.equal(sync.body.pending, true);
  } finally {
    gateway.close();
    await closeServer(server);
  }
});

test("policy fleet overview lists owned devices with sync state", async () => {
  const registry = await DeviceRegistry.open();
  await pairedDevice(registry, "Leno", "device-secret-s4-fleet-a", "account-a");
  await pairedDevice(registry, "office", "device-secret-s4-fleet-b", "account-b");
  const router = new DeviceRouter({
    registry,
  });
  const gateway = new RelayControlHttpGateway({
    registry,
    authenticator: auth(),
    disconnectDevice: () => undefined,
    router,
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const base = baseUrl(server);

  try {
    await jsonRequest(base, "/devices/Leno/policy", {
      method: "POST",
      token: "token-a",
      body: { allowedCapabilities: ["device.status"] },
    });
    const fleet = await jsonRequest(base, "/devices/policy", {
      method: "GET",
      token: "token-a",
    });
    assert.equal(fleet.status, 200);
    const devices = fleet.body.devices as Array<Record<string, unknown>>;
    assert.equal(devices.length, 1);
    assert.equal(devices[0]?.deviceId, "Leno");
    assert.equal(devices[0]?.pending, true);

    const other = await jsonRequest(base, "/devices/policy", {
      method: "GET",
      token: "token-b",
    });
    assert.equal(
      (other.body.devices as Array<unknown>).length,
      1,
      "account-b sees only its own device",
    );
  } finally {
    gateway.close();
    await closeServer(server);
  }
});

test("policy endpoints enforce ownership and validate payloads", async () => {
  const registry = await DeviceRegistry.open();
  await pairedDevice(registry, "Leno", "device-secret-s4-authz", "account-a");
  const router = new DeviceRouter({
    registry,
  });
  const gateway = new RelayControlHttpGateway({
    registry,
    authenticator: auth(),
    disconnectDevice: () => undefined,
    router,
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const base = baseUrl(server);

  try {
    const crossAccount = await jsonRequest(base, "/devices/Leno/policy", {
      method: "POST",
      token: "token-b",
      body: { allowedCapabilities: ["device.status"] },
    });
    assert.equal(crossAccount.status, 403);

    const crossRead = await jsonRequest(base, "/devices/Leno/policy", {
      method: "GET",
      token: "token-b",
    });
    assert.equal(crossRead.status, 403);

    const ghost = await jsonRequest(base, "/devices/ghost/policy", {
      method: "GET",
      token: "token-a",
    });
    assert.equal(ghost.status, 403);

    const noBearer = await jsonRequest(base, "/devices/Leno/policy", {
      method: "GET",
    });
    assert.equal(noBearer.status, 401);

    const malformed = await jsonRequest(base, "/devices/Leno/policy", {
      method: "POST",
      token: "token-a",
      body: { allowedCapabilities: "device.status" },
    });
    assert.equal(malformed.status, 400);

    const blank = await jsonRequest(base, "/devices/Leno/policy", {
      method: "POST",
      token: "token-a",
      body: { allowedCapabilities: ["  "] },
    });
    assert.equal(blank.status, 400);
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
    signal: AbortSignal.timeout(5_000),
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
