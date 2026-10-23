import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { WebSocketServer, type RawData } from "ws";

import { CdpWire } from "../src/cdp-control.ts";

// These are actual loopback sockets, with a disposable peer withholding the
// protocol reply. The outer observation budget detects the old infinite wait.
test("CDP command times out without replay and ignores its late reply", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connected = once(server, "connection");
  const wire = await CdpWire.connect(`ws://127.0.0.1:${address.port}`, { requestTimeoutMs: 40 });
  t.after(() => wire.close());
  const [peer] = await connected;
  const commands: Array<{id: number; method: string}> = [];
  peer.on("message", (data: RawData) => commands.push(JSON.parse(String(data))));
  const outcome = await Promise.race([
    wire.send("Runtime.evaluate", { expression: "synthetic-mutation" }).then(
      () => "unexpected success", (error: {code: string}) => error.code),
    delay(500, "still pending"),
  ]);
  assert.equal(outcome, "timeout", "silent CDP peer must not hold a command forever");
  assert.equal(commands.length, 1, "a command with an uncertain outcome must never be replayed");

  const next = wire.send("Target.getTargets");
  await once(peer, "message");
  peer.send(JSON.stringify({ id: commands[0]!.id, result: { stale: true } }));
  peer.send(JSON.stringify({ id: commands[1]!.id, result: { targetInfos: [] } }));
  assert.deepEqual(await next, { targetInfos: [] });
});

test("CDP connection times out and closes a peer withholding WebSocket upgrade", async t => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("data", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connected = once(server, "connection");
  const connection = CdpWire.connect(`ws://127.0.0.1:${address.port}`, { connectTimeoutMs: 40 });
  const [peer] = await connected;
  const closed = once(peer, "close").then(() => "closed");
  const outcome = await Promise.race([
    connection.then(wire => { wire.close(); return "unexpected success"; },
      (error: {code: string}) => error.code),
    delay(500, "still pending"),
  ]);
  assert.equal(outcome, "timeout", "upgrade wait must have its own deadline");
  assert.equal(await Promise.race([closed, delay(500, "still open")]), "closed");
});

test("CDP correlates out-of-order replies and preserves protocol errors", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connected = once(server, "connection");
  const wire = await CdpWire.connect(`ws://127.0.0.1:${address.port}`, { requestTimeoutMs: 1_000 });
  t.after(() => wire.close());
  const [peer] = await connected;
  const commands: Array<{id: number; method: string}> = [];
  const received = new Promise<void>(resolve => peer.on("message", (data: RawData) => {
    commands.push(JSON.parse(String(data)));
    if (commands.length === 3) resolve();
  }));
  const first = wire.send("Target.getTargets");
  const second = wire.send("Runtime.evaluate");
  const failed = assert.rejects(wire.send("Unknown.method"), { code: "provider_failure" });
  await received;
  peer.send(JSON.stringify({ id: commands[1]!.id, result: { second: true } }));
  peer.send(JSON.stringify({ id: commands[2]!.id, error: { message: "synthetic protocol error" } }));
  peer.send(JSON.stringify({ id: commands[0]!.id, result: { first: true } }));
  assert.deepEqual(await first, { first: true });
  assert.deepEqual(await second, { second: true });
  await failed;
});

for (const end of ["peer disconnect", "explicit close"]) {
  test(`CDP rejects every pending command on ${end}`, async t => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    t.after(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connected = once(server, "connection");
    const wire = await CdpWire.connect(`ws://127.0.0.1:${address.port}`);
    t.after(() => wire.close());
    const [peer] = await connected;
    const results = Promise.allSettled([wire.send("Runtime.evaluate"), wire.send("Target.getTargets")]);
    if (end === "peer disconnect") peer.terminate();
    else { wire.close(); wire.close(); }
    for (const result of await results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.equal(result.reason.code, "provider_failure");
    }
    await assert.rejects(wire.send("Target.getTargets"), { code: "provider_failure" });
  });
}
