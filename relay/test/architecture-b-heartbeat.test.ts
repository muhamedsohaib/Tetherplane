import assert from "node:assert/strict";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import test from "node:test";
import WebSocket from "ws";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";
import { DeviceRouter } from "../src/routing/device-router.ts";
import { DeviceWebSocketGateway } from "../src/devices/ws-gateway.ts";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, limit = 1800) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start >= limit) throw new Error("heartbeat test deadline");
    await wait(5);
  }
}
const secret = "synthetic-heartbeat-fixture-only";
const deviceId = "heartbeat-fixture";
const accountId = "fixture-account";

async function fixture(run: (f: {router: DeviceRouter; connect: (version?: number, autoPong?: boolean, target?: string) => Promise<WebSocket>}) => Promise<void>) {
  const registry = await DeviceRegistry.open();
  const pending = await registry.startPairing({deviceId, credentialHash: hashDeviceCredential(secret)});
  await registry.approvePairing({accountId, userCode: pending.userCode});
  const router = new DeviceRouter({registry, timeoutMs: 4000});
  const gateway = new DeviceWebSocketGateway({registry, router, heartbeat: {intervalMs: 40, staleMs: 160}});
  const server = createServer();
  gateway.attach(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const sockets: WebSocket[] = [];
  try {
    await run({router, connect: async (version, autoPong = false, target = deviceId) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/device`, {
        autoPong, headers: {authorization: `Device ${secret}`, "x-tetherplane-device-id": deviceId},
      });
      sockets.push(ws);
      await new Promise<void>((resolve, reject) => {ws.once("open", resolve); ws.once("error", reject);});
      if (version !== undefined) ws.send(JSON.stringify({
        type: "device_hello", deviceId: target, appliedPolicyRevision: null, heartbeatVersion: version,
      }));
      await until(() => router.isOnline(deviceId));
      return ws;
    }});
  } finally {
    for (const ws of sockets) ws.terminate();
    await gateway.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("legacy or wrong-device hello does not activate heartbeat enforcement", async () => {
  await fixture(async ({router, connect}) => {
    const ws = await connect(1, false, "wrong-device");
    let pings = 0;
    ws.on("ping", () => pings++);
    await wait(420);
    assert.equal(router.isOnline(deviceId), true);
    assert.equal(pings, 0);
  });
});

test("advertised independent heartbeat retires a silent socket and settles its pending route", async () => {
  await fixture(async ({router, connect}) => {
    const ws = await connect(1);
    let pings = 0;
    ws.on("ping", () => pings++);
    const start = performance.now();
    const result = router.call({accountId, clientId: "fixture-client", principalId: "human:fixture-account"}, {
      protocol_version: "1.0", request_id: "silent-route", principal_id: null, device_id: deviceId, job_id: null,
      capability: "device.status", arguments: {}, actor: {id: "fixture-client", kind: "ai_client"},
      session_id: null, response_mode: "compact", idempotency_key: null, preconditions: [], expectations: [],
    });
    await until(() => !router.isOnline(deviceId));
    assert.ok(pings >= 1);
    assert.ok(performance.now() - start < 1800);
    assert.equal((await result).error?.code, "disconnected");
  });
});

test("matching live Pong keeps the upgraded socket online despite unsolicited Pong", async () => {
  await fixture(async ({router, connect}) => {
    const ws = await connect(1);
    let pings = 0;
    ws.on("ping", (nonce) => {pings++; ws.pong("unrelated"); ws.pong(nonce);});
    await wait(500);
    assert.ok(pings >= 3);
    assert.equal(router.isOnline(deviceId), true);
  });
});

test("a delayed challenge may be acknowledged once but replay cannot renew liveness", async () => {
  await fixture(async ({router, connect}) => {
    const ws = await connect(1);
    let first: Buffer | null = null;
    let count = 0;
    let replay: ReturnType<typeof setInterval> | undefined;
    ws.on("ping", (nonce) => {
      count++;
      if (count === 1) first = Buffer.from(nonce);
      if (count === 2 && first) {
        ws.pong(first);
        replay = setInterval(() => { if (ws.readyState === WebSocket.OPEN && first) ws.pong(first); }, 8);
      }
    });
    try {
      await until(() => !router.isOnline(deviceId));
      assert.ok(count >= 2);
    } finally {if (replay) clearInterval(replay);}
  });
});

test("retirement timers of a superseded connection never affect its replacement", async () => {
  await fixture(async ({router, connect}) => {
    const old = await connect(1);
    let first = false;
    old.on("ping", () => {first = true;});
    await until(() => first);
    const replacement = await connect(1, true);
    await wait(460);
    assert.equal(old.readyState, WebSocket.CLOSED);
    assert.equal(replacement.readyState, WebSocket.OPEN);
    assert.equal(router.isOnline(deviceId), true);
  });
});