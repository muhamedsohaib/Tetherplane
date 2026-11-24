import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionBridgeClient,
  ExtensionSessionError,
  type ExtensionSocket,
  type ExtensionSocketFactory,
} from "../src/session.ts";

class FakeSocket implements ExtensionSocket {
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readyState = 0;

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(value: unknown): void {
    this.emit("message", {
      data: JSON.stringify(value),
    });
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeFactory implements ExtensionSocketFactory {
  readonly sockets: FakeSocket[] = [];

  create(_url: string): ExtensionSocket {
    const socket = new FakeSocket();
    this.sockets.push(socket);
    return socket;
  }
}

test("extension session authenticates with launch token before application messages", async () => {
  const factory = new FakeFactory();
  const client = new ExtensionBridgeClient({
    url: "ws://127.0.0.1:8123",
    launchToken: "launch-token",
    extensionId: "extension-test",
    socketFactory: factory,
  });

  const connecting = client.connect();
  const socket = factory.sockets[0];
  assert.ok(socket);
  socket.open();

  assert.deepEqual(JSON.parse(socket.sent[0] ?? "{}"), {
    type: "hello",
    token: "launch-token",
    extension_id: "extension-test",
  });

  socket.message({
    type: "hello_ack",
    authenticated: true,
  });
  await connecting;
  assert.equal(client.authenticated, true);

  client.send({
    type: "event",
    event: "pages_changed",
    data: { count: 2 },
  });
  assert.equal(socket.sent.length, 2);
});

test("extension session rejects sensitive outbound payload fields", async () => {
  const factory = new FakeFactory();
  const client = new ExtensionBridgeClient({
    url: "ws://127.0.0.1:8123",
    launchToken: "launch-token",
    extensionId: "extension-test",
    socketFactory: factory,
  });
  const connecting = client.connect();
  const socket = factory.sockets[0];
  assert.ok(socket);
  socket.open();
  socket.message({
    type: "hello_ack",
    authenticated: true,
  });
  await connecting;

  assert.throws(
    () =>
      client.send({
        type: "event",
        data: {
          cookie: "session=secret",
        },
      }),
    (error: unknown) =>
      error instanceof ExtensionSessionError &&
      error.code === "sensitive_data_forbidden",
  );
});

test("extension session can reconnect after prior socket closes", async () => {
  const factory = new FakeFactory();
  const client = new ExtensionBridgeClient({
    url: "ws://127.0.0.1:8123",
    launchToken: "launch-token",
    extensionId: "extension-test",
    socketFactory: factory,
  });

  const firstConnect = client.connect();
  const first = factory.sockets[0];
  assert.ok(first);
  first.open();
  first.message({
    type: "hello_ack",
    authenticated: true,
  });
  await firstConnect;
  first.close();
  assert.equal(client.authenticated, false);

  const secondConnect = client.connect();
  const second = factory.sockets[1];
  assert.ok(second);
  second.open();
  second.message({
    type: "hello_ack",
    authenticated: true,
  });
  await secondConnect;

  assert.equal(client.authenticated, true);
  assert.deepEqual(JSON.parse(second.sent[0] ?? "{}"), {
    type: "hello",
    token: "launch-token",
    extension_id: "extension-test",
  });
});

test("extension session delivers authenticated inbound commands", async () => {
  const factory = new FakeFactory();
  const client = new ExtensionBridgeClient({
    url: "ws://127.0.0.1:8123",
    launchToken: "launch-token",
    extensionId: "extension-test",
    socketFactory: factory,
  });

  const connecting = client.connect();
  const socket = factory.sockets[0];
  assert.ok(socket);
  socket.open();
  socket.message({
    type: "hello_ack",
    authenticated: true,
  });
  await connecting;

  const inbound = client.nextMessage();
  socket.message({
    type: "command",
    request_id: "request-1",
    operation: "pages",
    args: {},
  });

  assert.deepEqual(await inbound, {
    type: "command",
    request_id: "request-1",
    operation: "pages",
    args: {},
  });
});

test("authenticated extension session emits periodic keepalive traffic and cancels on close", async () => {
  const factory = new FakeFactory();
  let scheduled: (() => void) | null = null;
  let cancelledHandle: unknown = null;

  const client = new ExtensionBridgeClient({
    url: "ws://127.0.0.1:8123",
    launchToken: "launch-token",
    extensionId: "extension-test",
    socketFactory: factory,
    scheduleHeartbeat: (callback) => {
      scheduled = callback;
      return 1;
    },
    cancelHeartbeat: (handle) => {
      cancelledHandle = handle;
    },
  });

  const connecting = client.connect();
  const socket = factory.sockets[0];
  assert.ok(socket);

  socket.open();
  socket.message({
    type: "hello_ack",
    authenticated: true,
  });

  await connecting;

  const runHeartbeat = scheduled as (() => void) | null;
  assert.ok(runHeartbeat);
  runHeartbeat();

  assert.deepEqual(
    JSON.parse(socket.sent.at(-1) ?? "{}"),
    {
      type: "keepalive",
    },
  );

  client.close();
  assert.equal(cancelledHandle, 1);
});

test("unacknowledged authentication times out and permits a fresh session", async () => {
  const factory = new FakeFactory();
  const client = new ExtensionBridgeClient({
    url: "ws://127.0.0.1:8123",
    launchToken: "launch-token",
    extensionId: "extension-test",
    socketFactory: factory,
    connectTimeoutMs: 40,
  });
  const firstConnect = client.connect();
  const first = factory.sockets[0]!;
  first.open();
  await assert.rejects(firstConnect, /authentication deadline/);
  assert.equal(first.readyState, 3);
  assert.equal(client.authenticated, false);

  const secondConnect = client.connect();
  const second = factory.sockets[1]!;
  second.open();
  second.message({ type: "hello_ack", authenticated: true });
  await secondConnect;
  first.emit("close", {});
  first.message({ type: "command", request_id: "old", operation: "close" });
  assert.equal(client.authenticated, true);
  const next = client.nextMessage();
  second.message({ type: "command", request_id: "new", operation: "pages" });
  assert.equal((await next).request_id, "new");
  client.close();
});

test("disconnect discards buffered commands and errors release pending waiters", async () => {
  const factory = new FakeFactory();
  const client = new ExtensionBridgeClient({
    url: "ws://127.0.0.1:8123",
    launchToken: "launch-token",
    extensionId: "extension-test",
    socketFactory: factory,
  });
  const firstConnect = client.connect();
  const first = factory.sockets[0]!;
  first.open();
  first.message({ type: "hello_ack", authenticated: true });
  await firstConnect;
  first.message({ type: "command", request_id: "must-not-replay", operation: "perform" });
  first.close();
  await assert.rejects(client.nextMessage(), /not authenticated/);

  const secondConnect = client.connect();
  const second = factory.sockets[1]!;
  second.open();
  second.message({ type: "hello_ack", authenticated: true });
  await secondConnect;
  const waiting = assert.rejects(client.nextMessage(), /socket failed/);
  second.emit("error", {});
  await waiting;
  assert.equal(client.authenticated, false);
  assert.equal(second.readyState, 3);
});

test("explicit close settles an incomplete handshake and prevents late hello acknowledgement", async () => {
  const factory = new FakeFactory();
  const client = new ExtensionBridgeClient({
    url: "ws://127.0.0.1:8123",
    launchToken: "launch-token",
    extensionId: "extension-test",
    socketFactory: factory,
  });
  const connecting = client.connect();
  const first = factory.sockets[0]!;
  first.open();
  const rejected = assert.rejects(connecting, /session closed/);
  client.close();
  await rejected;
  first.message({ type: "hello_ack", authenticated: true });
  assert.equal(client.authenticated, false);
});
