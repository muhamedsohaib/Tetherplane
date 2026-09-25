import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  AuthLoginProofHttpGateway,
} from "../src/auth/login-proof-http.ts";
import {
  AuthLoginProofRegistry,
} from "../src/auth/login-proof-registry.ts";
import {
  DeviceRegistry,
  hashDeviceCredential,
} from "../src/devices/registry.ts";

test("auth login bridge starts, device-approves, and consumes one-time account proof", async () => {
  const devices = await pairedDevice();
  const proofs = new AuthLoginProofRegistry();
  const gateway = new AuthLoginProofHttpGateway({
    devices: devices.registry,
    proofs,
    bridgeToken: "bridge-secret-that-never-leaves-services",
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const base = baseUrl(server);

  try {
    const started = await jsonRequest(
      base,
      "/auth/device-login/start",
      {
        method: "POST",
        bearer: "bridge-secret-that-never-leaves-services",
        body: { interactionUid: "interaction_123" },
      },
    );
    assert.equal(started.status, 200);
    assert.match(
      String(started.body.userCode),
      /^[A-Z0-9]{4}-[A-Z0-9]{4}$/,
    );

    const pending = await jsonRequest(
      base,
      "/auth/device-login/consume",
      {
        method: "POST",
        bearer: "bridge-secret-that-never-leaves-services",
        body: {
          interactionUid: "interaction_123",
          userCode: started.body.userCode,
        },
      },
    );
    assert.equal(pending.status, 404);

    const approved = await jsonRequest(
      base,
      "/auth/device-login/approve",
      {
        method: "POST",
        deviceId: "Leno",
        deviceCredential: devices.secret,
        body: {
          interactionUid: "interaction_123",
          userCode: started.body.userCode,
        },
      },
    );
    assert.equal(approved.status, 200);
    assert.deepEqual(approved.body, { status: "approved" });

    const consumed = await jsonRequest(
      base,
      "/auth/device-login/consume",
      {
        method: "POST",
        bearer: "bridge-secret-that-never-leaves-services",
        body: {
          interactionUid: "interaction_123",
          userCode: started.body.userCode,
        },
      },
    );
    assert.equal(consumed.status, 200);
    assert.deepEqual(consumed.body, { accountId: "account-a" });

    const replay = await jsonRequest(
      base,
      "/auth/device-login/consume",
      {
        method: "POST",
        bearer: "bridge-secret-that-never-leaves-services",
        body: {
          interactionUid: "interaction_123",
          userCode: started.body.userCode,
        },
      },
    );
    assert.equal(replay.status, 404);
  } finally {
    gateway.close();
    await closeServer(server);
  }
});

test("auth login bridge separates service authentication from device authentication", async () => {
  const devices = await pairedDevice();
  const proofs = new AuthLoginProofRegistry();
  const gateway = new AuthLoginProofHttpGateway({
    devices: devices.registry,
    proofs,
    bridgeToken: "bridge-secret-that-never-leaves-services",
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const base = baseUrl(server);

  try {
    for (const bearer of [undefined, "wrong-bridge-token"]) {
      const response = await jsonRequest(
        base,
        "/auth/device-login/start",
        {
          method: "POST",
          ...(bearer ? { bearer } : {}),
          body: { interactionUid: "interaction_456" },
        },
      );
      assert.equal(response.status, 401);
    }

    const started = await jsonRequest(
      base,
      "/auth/device-login/start",
      {
        method: "POST",
        bearer: "bridge-secret-that-never-leaves-services",
        body: { interactionUid: "interaction_456" },
      },
    );
    assert.equal(started.status, 200);

    for (const credential of [undefined, "wrong-device-secret"]) {
      const response = await jsonRequest(
        base,
        "/auth/device-login/approve",
        {
          method: "POST",
          deviceId: "Leno",
          ...(credential
            ? { deviceCredential: credential }
            : {}),
          body: {
            interactionUid: "interaction_456",
            userCode: started.body.userCode,
          },
        },
      );
      assert.equal(response.status, 401);
    }

    const consumeWithDeviceSecret = await jsonRequest(
      base,
      "/auth/device-login/consume",
      {
        method: "POST",
        bearer: devices.secret,
        body: {
          interactionUid: "interaction_456",
          userCode: started.body.userCode,
        },
      },
    );
    assert.equal(consumeWithDeviceSecret.status, 401);
  } finally {
    gateway.close();
    await closeServer(server);
  }
});

async function pairedDevice(): Promise<{
  registry: DeviceRegistry;
  secret: string;
}> {
  const registry = await DeviceRegistry.open();
  const secret = "paired-device-secret-for-auth-login";
  const pending = await registry.startPairing({
    deviceId: "Leno",
    credentialHash: hashDeviceCredential(secret),
  });
  await registry.approvePairing({
    accountId: "account-a",
    userCode: pending.userCode,
  });
  return { registry, secret };
}

async function jsonRequest(
  base: string,
  pathname: string,
  options: {
    method: "POST";
    bearer?: string;
    deviceId?: string;
    deviceCredential?: string;
    body: Record<string, unknown>;
  },
): Promise<{
  status: number;
  body: Record<string, any>;
}> {
  const response = await fetch(base + pathname, {
    method: options.method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.bearer
        ? { authorization: `Bearer ${options.bearer}` }
        : {}),
      ...(options.deviceCredential
        ? {
            authorization:
              `Device ${options.deviceCredential}`,
          }
        : {}),
      ...(options.deviceId
        ? {
            "x-tetherplane-device-id": options.deviceId,
          }
        : {}),
    },
    body: JSON.stringify(options.body),
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
    server.close((error) =>
      error ? reject(error) : resolve(),
    ),
  );
}
