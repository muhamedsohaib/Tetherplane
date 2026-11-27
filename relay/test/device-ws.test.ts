import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
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
  RELAY_HEARTBEAT_INTERVAL_MS,
  RELAY_STALE_AFTER_MS,
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

// ---- S2: relay-side heartbeat, stale retirement, generation fencing ----

test(
  "stale blackhole socket is retired within the stale bound",
  { timeout: 15_000 },
  async () => {
    const secret = "device-secret-s2-stale-retire";
    const registry = await pairedRegistry(secret);
    const router = new DeviceRouter({ registry, timeoutMs: 10_000 });
    const gateway = new DeviceWebSocketGateway({
      registry,
      router,
      heartbeat: { intervalMs: 25, staleMs: 100 },
    });
    const server = createServer();
    gateway.attach(server, "/device");
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");

    // Raw TCP peer: completes the upgrade, then answers nothing —
    // a half-open blackhole (fault-matrix row 2, relay half).
    const raw = await rawDevice(address.port, {
      authorization: `Device ${secret}`,
      "x-tetherplane-device-id": "Leno",
    });

    try {
      await until(() => router.isOnline("Leno"));
      const call = router.call(
        {
          accountId: "account-a",
          clientId: "client-a",
          principalId: "human:account-a",
        },
        invocation("stale-1"),
      );
      const started = Date.now();
      await raw.closed();
      const elapsed = Date.now() - started;
      console.log(
        `s2 measured stale-socket retire: ${elapsed} ms (stale bound 100 ms)`,
      );
      assert.ok(
        elapsed < 5_000,
        `stale retire must be bounded, took ${elapsed} ms`,
      );
      assert.equal(router.isOnline("Leno"), false);
      const result = await call;
      assert.equal(result.error?.code, "disconnected");
      assert.equal(result.request_id, "stale-1");
    } finally {
      raw.close();
      await gateway.close();
      await closeServer(server);
    }
  },
);

test(
  "pong with wrong nonce retires immediately, without waiting for the stale bound",
  { timeout: 15_000 },
  async () => {
    const secret = "device-secret-s2-nonce-mismatch";
    const registry = await pairedRegistry(secret);
    const router = new DeviceRouter({ registry, timeoutMs: 10_000 });
    const gateway = new DeviceWebSocketGateway({
      registry,
      router,
      heartbeat: { intervalMs: 25, staleMs: 5_000 },
    });
    const server = createServer();
    gateway.attach(server, "/device");
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const raw = await rawDevice(address.port, {
      authorization: `Device ${secret}`,
      "x-tetherplane-device-id": "Leno",
    });

    try {
      await until(() => router.isOnline("Leno"));
      const started = Date.now();
      while (true) {
        const frame = await raw.readFrame();
        if (frame.opcode === OPCODE_PING) {
          raw.sendFrame(OPCODE_PONG, Buffer.from("wrong-nonce-echo"));
          break;
        }
      }
      await raw.closed();
      const elapsed = Date.now() - started;
      console.log(
        `s2 measured mismatch retire: ${elapsed} ms (stale bound 5000 ms)`,
      );
      assert.ok(
        elapsed < 1_000,
        `mismatched Pong must retire immediately, took ${elapsed} ms`,
      );
      assert.equal(router.isOnline("Leno"), false);
    } finally {
      raw.close();
      await gateway.close();
      await closeServer(server);
    }
  },
);

test(
  "healthy connection is never retired across many heartbeat intervals",
  { timeout: 15_000 },
  async () => {
    const secret = "device-secret-s2-healthy";
    const registry = await pairedRegistry(secret);
    const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
    const gateway = new DeviceWebSocketGateway({
      registry,
      router,
      heartbeat: { intervalMs: 25, staleMs: 100 },
    });
    const server = createServer();
    gateway.attach(server, "/device");
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/device`, {
      headers: {
        authorization: `Device ${secret}`,
        "x-tetherplane-device-id": "Leno",
      },
    });

    try {
      let pingsSeen = 0;
      socket.on("ping", () => {
        pingsSeen += 1;
      });
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
      await opened(socket);
      await until(() => router.isOnline("Leno"));
      await sleep(500);
      console.log(`s2 healthy connection observed ${pingsSeen} heartbeat pings`);
      assert.ok(
        pingsSeen >= 5,
        `expected steady heartbeats, saw ${pingsSeen}`,
      );
      assert.equal(socket.readyState, WebSocket.OPEN);
      assert.equal(router.isOnline("Leno"), true);
      const result = await router.call(
        {
          accountId: "account-a",
          clientId: "client-a",
          principalId: "human:account-a",
        },
        invocation("healthy-1"),
      );
      assert.equal(result.status, "success");
    } finally {
      socket.close();
      await gateway.close();
      await closeServer(server);
    }
  },
);

test(
  "unmatched ping traffic does not extend liveness",
  { timeout: 15_000 },
  async () => {
    const secret = "device-secret-s2-ping-confusion";
    const registry = await pairedRegistry(secret);
    const router = new DeviceRouter({ registry, timeoutMs: 10_000 });
    const gateway = new DeviceWebSocketGateway({
      registry,
      router,
      heartbeat: { intervalMs: 25, staleMs: 100 },
    });
    const server = createServer();
    gateway.attach(server, "/device");
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const raw = await rawDevice(address.port, {
      authorization: `Device ${secret}`,
      "x-tetherplane-device-id": "Leno",
    });

    // Chattering peer: sends Pings (which the server dutifully
    // Pongs) but never answers the relay's own nonce challenges.
    const pinger = setInterval(() => {
      try {
        raw.sendFrame(OPCODE_PING, Buffer.from("agent-ping"));
      } catch {
        // Retired: the socket is gone, nothing left to prove.
      }
    }, 10);
    try {
      await until(() => router.isOnline("Leno"));
      const started = Date.now();
      await raw.closed();
      const elapsed = Date.now() - started;
      console.log(
        `s2 measured ping-confusion retire: ${elapsed} ms (stale bound 100 ms)`,
      );
      assert.ok(
        elapsed < 5_000,
        `ping-only peer must still retire, took ${elapsed} ms`,
      );
      assert.equal(router.isOnline("Leno"), false);
    } finally {
      clearInterval(pinger);
      raw.close();
      await gateway.close();
      await closeServer(server);
    }
  },
);

test(
  "superseded socket timers cannot retire the live socket",
  { timeout: 15_000 },
  async () => {
    const secret = "device-secret-s2-supersede";
    const registry = await pairedRegistry(secret);
    const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
    const gateway = new DeviceWebSocketGateway({
      registry,
      router,
      heartbeat: { intervalMs: 25, staleMs: 150 },
    });
    const server = createServer();
    gateway.attach(server, "/device");
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const stale = await rawDevice(address.port, {
      authorization: `Device ${secret}`,
      "x-tetherplane-device-id": "Leno",
    });

    try {
      await until(() => router.isOnline("Leno"));
      await sleep(75);
      const live = new WebSocket(
        `ws://127.0.0.1:${address.port}/device`,
        {
          headers: {
            authorization: `Device ${secret}`,
            "x-tetherplane-device-id": "Leno",
          },
        },
      );
      try {
        live.on("message", (raw) => {
          const message = JSON.parse(String(raw)) as {
            type: string;
            routeId: string;
            invocation: { request_id: string };
          };
          assert.equal(message.type, "invoke");
          live.send(
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
        await opened(live);
        let supersedeCode = 0;
        while (true) {
          const frame = await stale.readFrame();
          if (frame.opcode === OPCODE_CLOSE) {
            supersedeCode = frame.payload.readUInt16BE(0);
            // Raw peers get no automatic close reply; echo it so the
            // server completes the closing handshake.
            stale.sendFrame(OPCODE_CLOSE, frame.payload);
            break;
          }
        }
        assert.equal(supersedeCode, 4000);
        await stale.closed();
        // Wait past the stale socket's original deadline: its timers
        // must not touch the replacement.
        await sleep(300);
        assert.equal(live.readyState, WebSocket.OPEN);
        assert.equal(router.isOnline("Leno"), true);
        const result = await router.call(
          {
            accountId: "account-a",
            clientId: "client-a",
            principalId: "human:account-a",
          },
          invocation("live-1"),
        );
        assert.equal(result.status, "success");
      } finally {
        live.close();
      }
    } finally {
      stale.close();
      await gateway.close();
      await closeServer(server);
    }
  },
);

test(
  "reconnect after retire gets a clean generation with no replay",
  { timeout: 15_000 },
  async () => {
    const secret = "device-secret-s2-clean-generation";
    const registry = await pairedRegistry(secret);
    const router = new DeviceRouter({ registry, timeoutMs: 10_000 });
    const gateway = new DeviceWebSocketGateway({
      registry,
      router,
      heartbeat: { intervalMs: 25, staleMs: 100 },
    });
    const server = createServer();
    gateway.attach(server, "/device");
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const stale = await rawDevice(address.port, {
      authorization: `Device ${secret}`,
      "x-tetherplane-device-id": "Leno",
    });

    try {
      await until(() => router.isOnline("Leno"));
      const oldCall = router.call(
        {
          accountId: "account-a",
          clientId: "client-a",
          principalId: "human:account-a",
        },
        invocation("old-1"),
      );
      let oldRouteId = "";
      while (true) {
        const frame = await stale.readFrame();
        if (frame.opcode === OPCODE_TEXT) {
          oldRouteId = (
            JSON.parse(frame.payload.toString("utf8")) as {
              routeId: string;
            }
          ).routeId;
          break;
        }
      }
      await stale.closed();
      const oldResult = await oldCall;
      assert.equal(oldResult.error?.code, "disconnected");
      assert.equal(oldResult.request_id, "old-1");

      const live = new WebSocket(
        `ws://127.0.0.1:${address.port}/device`,
        {
          headers: {
            authorization: `Device ${secret}`,
            "x-tetherplane-device-id": "Leno",
          },
        },
      );
      try {
        live.on("message", (raw) => {
          const message = JSON.parse(String(raw)) as {
            type: string;
            routeId: string;
            invocation: { request_id: string };
          };
          assert.equal(message.type, "invoke");
          live.send(
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
        await opened(live);
        await until(() => router.isOnline("Leno"));
        const newResult = await router.call(
          {
            accountId: "account-a",
            clientId: "client-a",
            principalId: "human:account-a",
          },
          invocation("new-1"),
        );
        assert.equal(newResult.status, "success");
        assert.equal(newResult.request_id, "new-1");
        // A stale result for the retired generation's route must be
        // dropped, never double-resolved onto the new generation.
        live.send(
          JSON.stringify({
            type: "result",
            routeId: oldRouteId,
            result: {
              protocol_version: "1.0",
              request_id: "old-1",
              status: "success",
              data: { replayed: true },
              delta: null,
              error: null,
              verification: "not_applicable",
              continuation: null,
              policy: null,
              timing: { duration_ms: 1 },
            },
          }),
        );
        await sleep(100);
        const afterResult = await router.call(
          {
            accountId: "account-a",
            clientId: "client-a",
            principalId: "human:account-a",
          },
          invocation("new-2"),
        );
        assert.equal(afterResult.status, "success");
        assert.equal(afterResult.request_id, "new-2");
      } finally {
        live.close();
      }
    } finally {
      stale.close();
      await gateway.close();
      await closeServer(server);
    }
  },
);

test("production heartbeat retires within the 60 s normative bound", () => {
  assert.ok(RELAY_HEARTBEAT_INTERVAL_MS > 0);
  assert.ok(RELAY_HEARTBEAT_INTERVAL_MS <= RELAY_STALE_AFTER_MS);
  assert.ok(RELAY_STALE_AFTER_MS <= 60_000);
});

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type RawPeer = {
  closed(): Promise<void>;
  close(): void;
  readFrame(): Promise<{ opcode: number; payload: Buffer }>;
  sendFrame(opcode: number, payload: Buffer): void;
};

const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

async function rawDevice(
  port: number,
  headers: Record<string, string>,
): Promise<RawPeer> {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const key = randomBytes(16).toString("base64");
  socket.write(
    [
      "GET /device HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n"),
  );
  const head = await readUntil(socket, Buffer.from("\r\n\r\n"));
  const statusLine = head.toString("utf8").split("\r\n")[0] ?? "";
  assert.match(statusLine, /^HTTP\/1\.1 101/);
  socket.on("error", () => undefined);
  const reader = frameReader(socket);
  return {
    closed: () => {
      if (socket.closed) return Promise.resolve();
      return new Promise<void>((resolve) => socket.once("close", () => resolve()));
    },
    close: () => {
      socket.destroy();
    },
    readFrame: () => reader.readFrame(),
    sendFrame: (opcode: number, payload: Buffer) => {
      assert.ok(payload.length < 126, "test frames are short");
      const mask = randomBytes(4);
      const header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        masked[i] = payload[i]! ^ mask[i % 4]!;
      }
      socket.write(Buffer.concat([header, mask, masked]));
    },
  };
}

function frameReader(socket: net.Socket): {
  readFrame(): Promise<{ opcode: number; payload: Buffer }>;
} {
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  let done = false;
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (wake) {
      const ready = wake;
      wake = null;
      ready();
    }
  });
  socket.once("close", () => {
    done = true;
    if (wake) {
      const ready = wake;
      wake = null;
      ready();
    }
  });
  async function readExactly(length: number): Promise<Buffer> {
    while (buffer.length < length) {
      if (done) throw new Error("socket closed while reading frame");
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    const out = Buffer.from(buffer.subarray(0, length));
    buffer = buffer.subarray(length);
    return out;
  }
  return {
    async readFrame() {
      const head = await readExactly(2);
      const opcode = head[0]! & 0x0f;
      let length = head[1]! & 0x7f;
      if (length === 126) {
        length = (await readExactly(2)).readUInt16BE(0);
      } else if (length === 127) {
        length = Number((await readExactly(8)).readBigUInt64BE(0));
      }
      const masked = (head[1]! & 0x80) !== 0;
      const mask = masked ? await readExactly(4) : null;
      const payload = await readExactly(length);
      if (mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i]! ^ mask[i % 4]!;
        }
      }
      return { opcode, payload };
    },
  };
}

async function readUntil(
  socket: net.Socket,
  marker: Buffer,
): Promise<Buffer> {
  let buffer = Buffer.alloc(0);
  while (true) {
    const index = buffer.indexOf(marker);
    if (index >= 0) {
      const head = buffer.subarray(0, index);
      const rest = buffer.subarray(index + marker.length);
      if (rest.length > 0) socket.unshift(rest);
      return head;
    }
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      socket.once("data", resolve);
      socket.once("error", reject);
      socket.once("close", () =>
        reject(new Error("socket closed before handshake completed")),
      );
    });
    buffer = Buffer.concat([buffer, chunk]);
  }
}
