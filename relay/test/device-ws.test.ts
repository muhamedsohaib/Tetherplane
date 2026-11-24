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
  type DeviceConnectionEvent,
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

test("relay evicts a silent authenticated socket despite mismatched Pongs, settles pending routes and accepts a fresh connection", async () => {
  const secret = "device-secret-for-heartbeat-test";
  const registry = await pairedRegistry(secret);
  const router = new DeviceRouter({ registry, timeoutMs: 10_000 });
  const events: DeviceConnectionEvent[] = [];
  const gateway = new DeviceWebSocketGateway({
    registry,
    router,
    heartbeatIntervalMs: 60,
    heartbeatTimeoutMs: 300,
    onConnectionEvent: (event) => events.push(event),
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = "ws://127.0.0.1:" + address.port + "/device";
  const headers = {
    authorization: "Device " + secret,
    "x-tetherplane-device-id": "Leno",
  };
  const stale = new WebSocket(url, { headers, autoPong: false });
  let wrongPongs = 0;
  let healthy: WebSocket | undefined;
  try {
    stale.on("ping", () => {
      wrongPongs += 1;
      stale.pong("not-the-challenge");
    });
    await opened(stale);
    await until(() => router.isOnline("Leno"));
    const resultPromise = router.call(
      { accountId: "account-a", clientId: "client-a", principalId: "human:account-a" },
      invocation("stale-inflight"),
    );
    await until(() => !router.isOnline("Leno"), 4_000);
    const result = await resultPromise;
    assert.equal(result.error?.code, "disconnected");
    assert.ok(wrongPongs > 0);
    const lost = events.find((event) => event.reason === "heartbeat_timeout");
    assert.ok(lost);
    assert.equal(lost.last_pong_age_ms, null);
    assert.equal(lost.session_id, events[0]?.session_id);
    assert.equal(events.filter((event) => event.event === "disconnected").length, 1);
    await closed(stale);

    healthy = new WebSocket(url, { headers });
    let pingCount = 0;
    healthy.on("ping", () => { pingCount += 1; });
    await opened(healthy);
    await until(() => pingCount >= 4, 4_000);
    assert.equal(router.isOnline("Leno"), true);
    assert.notEqual(events.at(-1)?.session_id, lost.session_id);
    assert.equal(events.at(-1)?.event, "connected");
    assert.ok(!JSON.stringify(events).includes(secret));
  } finally {
    stale.terminate();
    healthy?.terminate();
    await gateway.close();
    await closeServer(server);
  }
});

test("superseded heartbeat deadlines cannot remove a newer authenticated socket", async () => {
  const secret = "device-secret-for-generation-test";
  const registry = await pairedRegistry(secret);
  const router = new DeviceRouter({ registry });
  const events: DeviceConnectionEvent[] = [];
  const gateway = new DeviceWebSocketGateway({
    registry,
    router,
    heartbeatIntervalMs: 60,
    heartbeatTimeoutMs: 300,
    onConnectionEvent: (event) => events.push(event),
  });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = "ws://127.0.0.1:" + address.port + "/device";
  const headers = {
    authorization: "Device " + secret,
    "x-tetherplane-device-id": "Leno",
  };
  const first = new WebSocket(url, { headers, autoPong: false });
  let firstPing = false;
  let second: WebSocket | undefined;
  try {
    first.on("ping", () => { firstPing = true; });
    await opened(first);
    await until(() => firstPing, 4_000);
    second = new WebSocket(url, { headers });
    let secondPings = 0;
    second.on("ping", () => { secondPings += 1; });
    await opened(second);
    await closed(first);
    await until(() => secondPings >= 7, 4_000);
    assert.equal(router.isOnline("Leno"), true);
    assert.equal(events.filter((event) => event.reason === "superseded").length, 1);
    assert.equal(events.some((event) => event.reason === "heartbeat_timeout"), false);
    assert.equal(events.filter((event) => event.event === "connected").length, 2);
    await gateway.close();
    assert.equal(router.isOnline("Leno"), false);
    assert.equal(events.filter((event) => event.reason === "gateway_shutdown").length, 1);
  } finally {
    first.terminate();
    second?.terminate();
    await gateway.close();
    await closeServer(server);
  }
});
