import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";

import * as chromium from "./helpers/chromium-debug-port.ts";

type Shutdown = (profileDir: string, timeoutMs?: number) => Promise<void>;
const shutdown = (chromium as unknown as { closeChromiumFromProfile?: Shutdown })
  .closeChromiumFromProfile;

async function fixture(mode: "close" | "hang" | "error" = "close") {
  const profile = await mkdtemp(path.join(os.tmpdir(), "tether-cdp-cleanup-test-"));
  const server = createServer((_request, response) => response.end("{}"));
  const sockets = new WebSocketServer({ server, path: "/devtools/browser/owned-fixture" });
  const methods: string[] = [];
  sockets.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { id: number; method: string };
      methods.push(message.method);
      if (mode === "error") {
        socket.send(JSON.stringify({ id: message.id, error: { message: "fixture denied shutdown" } }));
      } else {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
        if (mode === "close") {
          socket.close();
          server.close();
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  await writeFile(path.join(profile, "DevToolsActivePort"),
    String(port) + "\n/devtools/browser/owned-fixture\n", "utf8");
  return {
    profile, port, methods,
    async close() {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

test("owned debugger shutdown works without a surviving launcher PID and releases its listener", async () => {
  const f = await fixture();
  try {
    assert.equal(typeof shutdown, "function", "cleanup must use the owned browser endpoint independently of launcher lifetime");
    await shutdown!(f.profile, 2000);
    assert.deepEqual(f.methods, ["Browser.close"]);
    await assert.rejects(fetch("http://127.0.0.1:" + f.port, { signal: AbortSignal.timeout(500) }));
  } finally { await f.close(); }
});

test("a shutdown acknowledgement without releasing the debugger is a bounded cleanup failure", async () => {
  const f = await fixture("hang");
  try {
    assert.equal(typeof shutdown, "function");
    await assert.rejects(shutdown!(f.profile, 150), /timed out|did not close/i);
    assert.deepEqual(f.methods, ["Browser.close"]);
  } finally { await f.close(); }
});

test("a browser shutdown rejection is reported instead of swallowed", async () => {
  const f = await fixture("error");
  try {
    assert.equal(typeof shutdown, "function");
    await assert.rejects(shutdown!(f.profile, 2000), /denied shutdown/);
    assert.deepEqual(f.methods, ["Browser.close"]);
  } finally { await f.close(); }
});

test("invalid or foreign browser paths never receive a shutdown command", async () => {
  const f = await fixture();
  try {
    assert.equal(typeof shutdown, "function");
    for (const browserPath of ["/devtools/page/human", "//elsewhere/devtools/browser/id", "/devtools/browser/owned-fixture?x=1"]) {
      await writeFile(path.join(f.profile, "DevToolsActivePort"),
        String(f.port) + "\n" + browserPath + "\n", "utf8");
      await assert.rejects(shutdown!(f.profile, 500), /browser endpoint/i);
    }
    assert.deepEqual(f.methods, []);
  } finally { await f.close(); }
});

test("a recycled debugging port does not authorize a different browser endpoint", async () => {
  const f = await fixture();
  try {
    assert.equal(typeof shutdown, "function");
    await writeFile(path.join(f.profile, "DevToolsActivePort"),
      String(f.port) + "\n/devtools/browser/old-browser\n", "utf8");
    await assert.rejects(shutdown!(f.profile, 2000));
    assert.deepEqual(f.methods, []);
  } finally { await f.close(); }
});
