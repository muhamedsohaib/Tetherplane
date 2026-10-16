import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import * as chromium from "./helpers/chromium-debug-port.ts";

type Defer = (cleanup: () => void | Promise<void>) => void;
type Scope = <T>(body: (defer: Defer) => Promise<T>) => Promise<T>;
const scope = (chromium as unknown as { withChromiumTestResources?: Scope }).withChromiumTestResources;
type Client = { send(method: string): Promise<unknown>; close(): void };
const connect = (chromium as unknown as { connectTestCdp?: (url: string, timeoutMs?: number) => Promise<Client> }).connectTestCdp;

test("registration setup failure releases both acquired HTTP listeners without starting Chromium", async () => {
  const first = createServer((_request, response) => response.end("invalid-json"));
  const second = createServer();
  try {
    assert.equal(typeof scope, "function");
    await assert.rejects(scope!(async (defer) => {
      for (const server of [first, second]) {
        defer(async () => { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
      }
      const address = first.address() as { port: number };
      await (await fetch("http://127.0.0.1:" + address.port, { signal: AbortSignal.timeout(1000) })).json();
    }));
    assert.equal(first.listening, false);
    assert.equal(second.listening, false);
  } finally {
    for (const server of [first, second]) { server.closeAllConnections(); if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test("one teardown failure does not skip other resources or hide the original setup failure", async () => {
  assert.equal(typeof scope, "function");
  const cleaned: string[] = [];
  const original = new Error("registration failed");
  const cleanup = new Error("browser cleanup failed");
  await assert.rejects(scope!(async (defer) => {
    defer(() => { cleaned.push("storage"); });
    defer(() => { cleaned.push("browser"); throw cleanup; });
    throw original;
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, cleanup]);
    return true;
  });
  assert.deepEqual(cleaned, ["browser", "storage"]);
});

test("CDP request deadlines and explicit close reject outstanding work without hanging", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let client: Client | undefined;
  try {
    assert.equal(typeof connect, "function");
    const port = (server.address() as { port: number }).port;
    client = await connect!("ws://127.0.0.1:" + port, 100);
    await assert.rejects(client.send("Page.enable"), /timed out/i);
    const pending = client.send("Runtime.enable");
    client.close();
    await assert.rejects(pending, /closed/i);
  } finally {
    client?.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
