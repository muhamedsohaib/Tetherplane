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

const EXT_ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EXT_ORIGIN_A = `chrome-extension://${EXT_ID_A}`;
const EXT_ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EXT_ORIGIN_B = `chrome-extension://${EXT_ID_B}`;

function expectUpgradeRejected403(
  url: string,
  origin?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = origin
      ? new WebSocket(url, { headers: { origin } })
      : new WebSocket(url);
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve();
    };
    socket.once("open", () => {
      finish(new Error("expected WebSocket upgrade to be rejected with 403"));
    });
    socket.once("unexpected-response", (_req, res) => {
      try {
        assert.equal(res.statusCode, 403);
        finish();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.once("error", (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

test("extension bridge binds localhost and authenticates launch token before messages", async () => {
  const bridge = await startExtensionBridgeServer({
    launchToken: "launch-token-123",
  });
  const socket = new WebSocket(bridge.url, {
    headers: { origin: EXT_ORIGIN_A },
  });

  try {
    assert.match(bridge.url, /^ws:\/\/127\.0\.0\.1:/);
    await onceOpen(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        token: "launch-token-123",
        extension_id: EXT_ID_A,
      }),
    );

    const ack = await onceMessage(socket);
    assert.deepEqual(ack, {
      type: "hello_ack",
      authenticated: true,
    });

    const client = await bridge.waitForAuthenticatedClient();
    assert.equal(client.extension_id, EXT_ID_A);

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
  const socket = new WebSocket(bridge.url, {
    headers: { origin: EXT_ORIGIN_A },
  });

  try {
    await onceOpen(socket);
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        token: "wrong-token",
        extension_id: EXT_ID_A,
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
  const socket = new WebSocket(bridge.url, {
    headers: { origin: EXT_ORIGIN_A },
  });

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
  const socket = new WebSocket(bridge.url, {
    headers: { origin: EXT_ORIGIN_A },
  });

  try {
    await onceOpen(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        token: "launch-token",
        extension_id: EXT_ID_A,
      }),
    );
    await onceMessage(socket);
    const client = await bridge.waitForAuthenticatedClient();

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
    await assert.rejects(
      client.nextMessage(),
      /extension bridge client (?:is )?disconnected/,
    );
  } finally {
    socket.close();
    await bridge.close();
  }
});


test("authenticated extension client exposes a close signal", async () => {
  const bridge = await startExtensionBridgeServer({
    launchToken: "launch-token-close",
  });
  const socket = new WebSocket(bridge.url, {
    headers: { origin: EXT_ORIGIN_B },
  });

  try {
    await onceOpen(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        token: "launch-token-close",
        extension_id: EXT_ID_B,
      }),
    );
    await onceMessage(socket);

    const client = await bridge.waitForAuthenticatedClient();
    assert.ok(client.closed instanceof Promise);

    socket.close();
    await client.closed;
    assert.equal(bridge.authenticatedClientCount(), 0);
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("extension bridge consumes keepalive internally", async () => {
  const bridge = await startExtensionBridgeServer({
    launchToken: "launch-token",
  });

  const socket = new WebSocket(bridge.url, {
    headers: { origin: EXT_ORIGIN_A },
  });

  try {
    await onceOpen(socket);

    socket.send(
      JSON.stringify({
        type: "hello",
        token: "launch-token",
        extension_id: EXT_ID_A,
      }),
    );

    await onceMessage(socket);

    const client =
      await bridge.waitForAuthenticatedClient();

    socket.send(
      JSON.stringify({
        type: "keepalive",
      }),
    );

    socket.send(
      JSON.stringify({
        type: "event",
        event: "after_keepalive",
      }),
    );

    assert.deepEqual(
      await client.nextMessage(),
      {
        type: "event",
        event: "after_keepalive",
      },
    );
  } finally {
    socket.close();
    await bridge.close();
  }
});

test("F-6: rejects missing, HTTP, malformed, and unpinned WebSocket upgrade Origins with 403", async () => {
  let dynamicPinnedId: string | null = null;
  const bridgeStatic = await startExtensionBridgeServer({
    launchToken: "launch-token-f6",
    expectedExtensionId: EXT_ID_A,
  });
  const bridgeDynamic = await startExtensionBridgeServer({
    launchToken: "launch-token-f6-dyn",
    expectedExtensionId: async () => dynamicPinnedId,
  });

  try {
    await expectUpgradeRejected403(bridgeStatic.url);
    await expectUpgradeRejected403(bridgeStatic.url, "http://127.0.0.1");
    await expectUpgradeRejected403(bridgeStatic.url, "https://evil.example");
    await expectUpgradeRejected403(
      bridgeStatic.url,
      "chrome-extension://not-a-valid-extension-id",
    );
    await expectUpgradeRejected403(bridgeStatic.url, EXT_ORIGIN_B);

    // Dynamic resolver permits valid chrome-extension Origin while null, then pins after update
    const firstSocket = new WebSocket(bridgeDynamic.url, {
      headers: { origin: EXT_ORIGIN_A },
    });
    await onceOpen(firstSocket);
    firstSocket.send(
      JSON.stringify({
        type: "hello",
        token: "launch-token-f6-dyn",
        extension_id: EXT_ID_A,
      }),
    );
    await onceMessage(firstSocket);
    firstSocket.close();

    dynamicPinnedId = EXT_ID_A;
    await expectUpgradeRejected403(bridgeDynamic.url, EXT_ORIGIN_B);
  } finally {
    await bridgeStatic.close();
    await bridgeDynamic.close();
  }
});

function expectClosedWithCode(
  socket: WebSocket,
  timeoutMs = 1500,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      reject(new Error(`timed out after ${timeoutMs}ms waiting for socket close`));
    }, timeoutMs);
    timer.unref?.();
    socket.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test("F-6: rejects hello extension_id mismatch and wrong-length tokens with 4001", async () => {
  const bridge = await startExtensionBridgeServer({
    launchToken: "launch-token-f6-check",
  });
  const openSockets: WebSocket[] = [];
  try {
    // Mismatched hello.extension_id vs verified upgrade Origin
    const mismatchSocket = new WebSocket(bridge.url, {
      headers: { origin: EXT_ORIGIN_A },
    });
    openSockets.push(mismatchSocket);
    await onceOpen(mismatchSocket);
    const mismatchClosed = expectClosedWithCode(mismatchSocket);
    mismatchSocket.send(
      JSON.stringify({
        type: "hello",
        token: "launch-token-f6-check",
        extension_id: EXT_ID_B,
      }),
    );
    assert.equal(await mismatchClosed, 4001);

    // Wrong-length and same-length wrong tokens rejected identically
    for (const badToken of ["short", "launch-token-f6-checl", "launch-token-f6-check-longer", ""]) {
      const sock = new WebSocket(bridge.url, {
        headers: { origin: EXT_ORIGIN_A },
      });
      openSockets.push(sock);
      await onceOpen(sock);
      const closed = expectClosedWithCode(sock);
      sock.send(
        JSON.stringify({
          type: "hello",
          token: badToken,
          extension_id: EXT_ID_A,
        }),
      );
      assert.equal(await closed, 4001);
    }
    assert.equal(bridge.authenticatedClientCount(), 0);
  } finally {
    for (const sock of openSockets) {
      try {
        sock.terminate();
      } catch {
        // ignore
      }
    }
    await bridge.close();
  }
});
