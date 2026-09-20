import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import WebSocket from "ws";

import {
  DeviceRegistry,
  hashDeviceCredential,
} from "../src/devices/registry.ts";
import {
  DeviceRouter,
} from "../src/routing/device-router.ts";
import {
  DeviceWebSocketGateway,
} from "../src/devices/ws-gateway.ts";

test("paired device authenticates over websocket and carries routed canonical RPC", async () => {
  const secret = "device-secret-for-live-websocket";
  const registry = await pairedRegistry(secret);
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const gateway = new DeviceWebSocketGateway({ registry, router });
  const server = createServer();
  gateway.attach(server, "/device");
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/device`,
    {
      headers: {
        authorization: `Device ${secret}`,
        "x-tetherplane-device-id": "Leno",
      },
    },
  );

  try {
    await opened(socket);
    await until(() => router.isOnline("Leno"));

    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as {
        type: string;
        routeId: string;
        invocation: { request_id: string };
      };
      assert.equal(message.type, "invoke");
      socket.send(
        JSON.stringify({
          type: "result",
          routeId: message.routeId,
          result: {
            protocol_version: "1.0",
            request_id: message.invocation.request_id,
            status: "success",
            data: { remote: true },
            delta: null,
            error: null,
            verification: "not_applicable",
            continuation: null,
            policy: null,
            timing: { duration_ms: 1 },
          },
        }),
      );
    });

    const result = await router.call(
      {
        accountId: "account-a",
        clientId: "client-a",
        principalId: "human:account-a",
      },
      invocation("remote-1"),
    );
    assert.equal(result.status, "success");
    assert.deepEqual(result.data, { remote: true });
  } finally {
    socket.close();
    await gateway.close();
    await closeServer(server);
  }
});

test("wrong device credential is rejected before router presence", async () => {
  const registry = await pairedRegistry(
    "device-secret-for-auth-rejection",
  );
  const router = new DeviceRouter({ registry });
  const gateway = new DeviceWebSocketGateway({ registry, router });
  const server = createServer();
  gateway.attach(server, "/device");
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const status = await rejectedStatus(
      `ws://127.0.0.1:${address.port}/device`,
      {
        authorization: "Device definitely-wrong-device-secret",
        "x-tetherplane-device-id": "Leno",
      },
    );
    assert.equal(status, 401);
    assert.equal(router.isOnline("Leno"), false);
  } finally {
    await gateway.close();
    await closeServer(server);
  }
});

test("gateway can disconnect a revoked live device", async () => {
  const secret = "device-secret-for-revocation-test";
  const registry = await pairedRegistry(secret);
  const router = new DeviceRouter({ registry });
  const gateway = new DeviceWebSocketGateway({ registry, router });
  const server = createServer();
  gateway.attach(server, "/device");
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/device`,
    {
      headers: {
        authorization: `Device ${secret}`,
        "x-tetherplane-device-id": "Leno",
      },
    },
  );

  try {
    await opened(socket);
    await until(() => router.isOnline("Leno"));
    await registry.revokeDevice({
      accountId: "account-a",
      deviceId: "Leno",
    });
    gateway.disconnectDevice("Leno");
    await closed(socket);
    assert.equal(router.isOnline("Leno"), false);
  } finally {
    socket.close();
    await gateway.close();
    await closeServer(server);
  }
});

async function pairedRegistry(
  secret: string,
): Promise<DeviceRegistry> {
  const registry = await DeviceRegistry.open();
  const pending = await registry.startPairing({
    deviceId: "Leno",
    credentialHash: hashDeviceCredential(secret),
  });
  await registry.approvePairing({
    accountId: "account-a",
    userCode: pending.userCode,
  });
  return registry;
}

function invocation(requestId: string) {
  return {
    protocol_version: "1.0" as const,
    request_id: requestId,
    principal_id: null,
    device_id: "Leno",
    job_id: null,
    capability: "device.status",
    arguments: {},
    actor: { id: "test", kind: "ai_client" as const },
    session_id: null,
    response_mode: "compact" as const,
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function opened(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

async function rejectedStatus(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("websocket unexpectedly authenticated"));
    });
    socket.once("error", () => undefined);
  });
}

async function until(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for websocket state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
