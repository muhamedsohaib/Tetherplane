import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";
import { CdpWire } from "../src/cdp-control.ts";
import { CdpBackendError } from "../src/cdp-backend.ts";

function hasCode(code: string) {
  return (error: unknown) => error instanceof CdpBackendError && error.code === code;
}

test("owned CDP rejects nonloopback endpoints and unrelated websocket paths", async () => {
  await assert.rejects(CdpWire.connect("ws://192.0.2.1:9222/devtools/browser/fixture"), hasCode("invalid_arguments"));
  await assert.rejects(CdpWire.connect("ws://127.0.0.1:9222/devtools/page/fixture"), hasCode("invalid_arguments"));
});

test("owned CDP handshake deadline retires a stalled upgrade socket", { timeout: 5000 }, async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const start = performance.now();
    await assert.rejects(CdpWire.connect(
      "ws://127.0.0.1:" + address.port + "/devtools/browser/fixture",
      { handshakeTimeoutMs: 150 },
    ), (error: unknown) => error instanceof CdpBackendError && ["timeout", "provider_failure"].includes(error.code));
    assert.ok(performance.now() - start < 2000);
    const deadline = performance.now() + 1000;
    while (sockets.size && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(sockets.size, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("lost CDP command result retires the session, never replays mutations, and permits a fresh channel", { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const received: Array<{ generation: number; method: string }> = [];
  let generation = 0;
  let first: CdpWire | undefined;
  let replacement: CdpWire | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    server.on("connection", socket => {
      const current = ++generation;
      socket.on("message", data => {
        const request = JSON.parse(String(data)) as { id: number; method: string };
        received.push({ generation: current, method: request.method });
        if (current > 1) {
          socket.send(JSON.stringify({ id: request.id, result: { targetInfos: [] } }));
        }
      });
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = "ws://127.0.0.1:" + address.port + "/devtools/browser/fixture";
    first = await CdpWire.connect(url, { commandTimeoutMs: 150 });
    const mutation = first.send("Runtime.callFunctionOn", { functionDeclaration: "function() { return true; }" });
    const observation = first.send("Target.getTargets");
    await Promise.all([
      assert.rejects(mutation, hasCode("action_outcome_unknown")),
      assert.rejects(observation, hasCode("timeout")),
    ]);
    assert.equal(first.isConnected(), false);
    await assert.rejects(first.send("Target.createTarget", { url: "about:blank" }), hasCode("capability_unavailable"));
    replacement = await CdpWire.connect(url, { commandTimeoutMs: 1000 });
    assert.deepEqual(await replacement.send("Target.getTargets"), { targetInfos: [] });
    assert.deepEqual(received, [
      { generation: 1, method: "Runtime.callFunctionOn" },
      { generation: 1, method: "Target.getTargets" },
      { generation: 2, method: "Target.getTargets" },
    ]);
  } finally {
    first?.close();
    replacement?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
