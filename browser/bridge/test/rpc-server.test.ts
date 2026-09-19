import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  BrowserBridgeService,
  BrowserOwnershipRegistry,
  startBrowserRpcServer,
  type BrowserServiceBackend,
  type BrowserServicePage,
} from "../src/index.ts";

class FakeBackend implements BrowserServiceBackend {
  readonly performed: unknown[] = [];
  readonly pagesState: BrowserServicePage[] = [
    { page_id: "human-1", ownership: "human" as const, active: true, url: "https://human.test" },
  ];

  capabilities() {
    return { backend: "fake", operations: ["pages", "create_tab", "snapshot", "act", "navigate", "close"] };
  }
  async pages() { return structuredClone(this.pagesState); }
  async createTab(url: string) {
    const page = { page_id: "owned-1", ownership: "tetherplane" as const, active: false, url };
    this.pagesState.push(page);
    return structuredClone(page);
  }
  async navigate(pageId: string, url: string) {
    this.performed.push({ kind: "navigate", pageId, url });
    const page = this.pagesState.find((item) => item.page_id === pageId)!;
    page.url = url;
    return structuredClone(page);
  }
  async close(pageId: string) { this.performed.push({ kind: "close", pageId }); }
  async observe(pageId: string) {
    return { page_id: pageId, url: this.pagesState.find((item) => item.page_id === pageId)!.url, semantic_revision: 1, resource_revision: "1", nodes: [], validation_messages: [], toasts: [] };
  }
  async perform() { this.performed.push({ kind: "perform" }); }
  async waitForSettled(pageId: string) { return this.observe(pageId); }
  async uploadFile() {}
  async downloads() { return []; }
  async diagnostics() { return []; }
}

async function rpc(address: string, request: Record<string, unknown>) {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = net.createConnection(Number(address.split(":").at(-1)), "127.0.0.1");
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      }
    });
    socket.on("error", reject);
  });
}

test("RPC handshake authenticates and reports actual operations", async () => {
  const backend = new FakeBackend();
  const server = await startBrowserRpcServer({
    host: "127.0.0.1",
    port: 0,
    token: "launch-token",
    service: new BrowserBridgeService({ backend, ownership: new BrowserOwnershipRegistry() }),
  });
  try {
    const denied = await rpc(server.address, { type: "handshake", request_id: "handshake", token: "wrong" });
    assert.equal(denied.status, "error");
    const accepted = await rpc(server.address, { type: "handshake", request_id: "handshake", token: "launch-token" });
    assert.equal(accepted.status, "success");
    assert.ok(Array.isArray((accepted.data as Record<string, unknown>).operations));
  } finally {
    await server.close();
  }
});

test("service never trusts caller-supplied ownership for a human page", async () => {
  const backend = new FakeBackend();
  const server = await startBrowserRpcServer({
    host: "127.0.0.1",
    port: 0,
    service: new BrowserBridgeService({ backend, ownership: new BrowserOwnershipRegistry() }),
  });
  try {
    await rpc(server.address, { type: "handshake", request_id: "handshake" });
    const response = await rpc(server.address, {
      type: "invoke",
      request_id: "request-1",
      capability: "browser.navigate",
      arguments: { page_id: "human-1", url: "https://attacker.test", ownership: "tetherplane" },
    });
    assert.equal(response.status, "error");
    assert.equal((response.error as Record<string, unknown>).code, "permission_denied");
    assert.equal(backend.performed.length, 0);
  } finally {
    await server.close();
  }
});
