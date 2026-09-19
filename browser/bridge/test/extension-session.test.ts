import assert from "node:assert/strict";
import test from "node:test";

import WebSocket from "ws";

import { startExtensionBridgeServer } from "../src/index.ts";

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function onceMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(String(data)) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

test("extension bridge binds localhost and authenticates launch token before messages", async () => {
  const bridge = await startExtensionBridgeServer({
    launchToken: "launch-token-123",
  });
  const socket = new WebSocket(bridge.url);

  try {
    assert.match(bridge.url, /^ws:\/\/127\.0\.0\.1:/);
    await onceOpen(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        token: "launch-token-123",
        extension_id: "extension-test",
      }),
    );

    const ack = await onceMessage(socket);
    assert.deepEqual(ack, {
      type: "hello_ack",
      authenticated: true,
    });

    const client = await bridge.waitForAuthenticatedClient();
    assert.equal(client.extension_id, "extension-test");

    socket.send(
      JSON.stringify({
        type: "event",
        event: "pages_changed",
        data: { count: 2 },
      }),
    );
    assert.deepEqual(await client.nextMessage(), {
      type: "event",
      event: "pages_changed",
      data: { count: 2 },
    });
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("extension bridge rejects wrong launch token before accepting application messages", async () => {
  const bridge = await startExtensionBridgeServer({
    launchToken: "correct-token",
  });
  const socket = new WebSocket(bridge.url);

  try {
    await onceOpen(socket);
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        token: "wrong-token",
        extension_id: "attacker",
      }),
    );
    assert.equal(await closed, 4001);
    assert.equal(bridge.authenticatedClientCount(), 0);
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("extension bridge never authenticates non-hello first messages", async () => {
  const bridge = await startExtensionBridgeServer({
    launchToken: "launch-token",
  });
  const socket = new WebSocket(bridge.url);

  try {
    await onceOpen(socket);
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(
      JSON.stringify({
        type: "event",
        token: "launch-token",
        data: {
          cookie: "must-not-be-accepted-before-authentication",
        },
      }),
    );
    assert.equal(await closed, 4001);
    assert.equal(bridge.authenticatedClientCount(), 0);
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("extension bridge rejects credential-shaped payloads after authentication", async () => {
  const bridge = await startExtensionBridgeServer({
    launchToken: "launch-token",
  });
  const socket = new WebSocket(bridge.url);

  try {
    await onceOpen(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        token: "launch-token",
        extension_id: "extension-test",
      }),
    );
    await onceMessage(socket);
    await bridge.waitForAuthenticatedClient();

    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(
      JSON.stringify({
        type: "event",
        event: "unsafe",
        data: {
          authorization: "Bearer secret",
        },
      }),
    );

    assert.equal(await closed, 4003);
    assert.equal(bridge.authenticatedClientCount(), 0);
  } finally {
    socket.close();
    await bridge.close();
  }
});
