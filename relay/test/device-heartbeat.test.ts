import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import WebSocket from "ws";

import {
  DeviceRegistry,
  hashDeviceCredential,
} from "../src/devices/registry.ts";
import { DeviceRouter } from "../src/routing/device-router.ts";
import { DeviceWebSocketGateway } from "../src/devices/ws-gateway.ts";

test("missed websocket Pong fences old generation without replaying an in-flight mutation", async () => {
  const credential = "isolated-heartbeat-fixture-credential";
  const registry = await DeviceRegistry.open();
  const pairing = await registry.startPairing({
    deviceId: "Leno",
    credentialHash: hashDeviceCredential(credential),
  });
  await registry.approvePairing({
    accountId: "account-a",
    userCode: pairing.userCode,
  });
  const router = new DeviceRouter({ registry, timeoutMs: 5_000 });
  // Use a named variable so the behavior, not excess-property typing,
  // fails against the old gateway without heartbeat support.
  const gatewayOptions = { registry, router, heartbeatIntervalMs: 150 };
  const gateway = new DeviceWebSocketGateway(gatewayOptions);
  const server = createServer();
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = "ws://127.0.0.1:" + address.port + "/device";
  const headers = {
    authorization: "Device " + credential,
    "x-tetherplane-device-id": "Leno",
  };
  const silent = new WebSocket(url, { headers, autoPong: false });
  let replacement: WebSocket | undefined;
  let firstDeliveries = 0;
  let replacementDeliveries = 0;
  let unansweredPings = 0;

  const identity = {
    accountId: "account-a",
    clientId: "client-a",
    principalId: "human:account-a",
  };

  try {
    await opened(silent);
    await until(() => router.isOnline("Leno"));
    silent.on("message", () => firstDeliveries++);
    silent.on("ping", () => unansweredPings++);
    const pending = router.call(identity, invocation("uncertain-effect", "process.run"));
    await until(() => firstDeliveries === 1);
    await until(() => !router.isOnline("Leno"), 3_000);

    assert.ok(unansweredPings > 0, "device should have received a Ping");
    assert.equal((await pending).error?.code, "disconnected");
    assert.equal(firstDeliveries, 1);

    replacement = new WebSocket(url, { headers });
    await opened(replacement);
    await until(() => router.isOnline("Leno"));
    let healthyPings = 0;
    replacement.on("ping", () => healthyPings++);
    replacement.on("message", (raw) => {
      replacementDeliveries++;
      const request = JSON.parse(String(raw)) as {
        routeId: string;
        invocation: { request_id: string };
      };
      replacement?.send(JSON.stringify({
        type: "result",
        routeId: request.routeId,
        result: {
          protocol_version: "1.0",
          request_id: request.invocation.request_id,
          status: "success",
          data: { agent_version: "test-only" },
          delta: null,
          error: null,
          verification: "not_applicable",
          continuation: null,
          policy: null,
          timing: { duration_ms: 0 },
        },
      }));
    });

    await until(() => healthyPings >= 2, 3_000);
    assert.equal(router.isOnline("Leno"), true, "healthy connection was evicted");
    assert.equal(replacementDeliveries, 0, "uncertain mutation was automatically replayed");

    const status = await router.call(identity, invocation("fresh-status", "device.status"));
    assert.equal(status.status, "success");
    assert.equal(replacementDeliveries, 1);
    assert.equal(firstDeliveries, 1);
  } finally {
    silent.terminate();
    replacement?.terminate();
    await gateway.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

function invocation(requestId: string, capability: string) {
  return {
    protocol_version: "1.0" as const,
    request_id: requestId,
    principal_id: null,
    device_id: "Leno",
    job_id: null,
    capability,
    arguments: {},
    actor: { id: "client-a", kind: "ai_client" as const },
    session_id: null,
    response_mode: "compact" as const,
    idempotency_key: capability === "process.run" ? "never-replay-effect" : null,
    preconditions: [],
    expectations: [],
  };
}

async function opened(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("heartbeat state deadline exceeded");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
