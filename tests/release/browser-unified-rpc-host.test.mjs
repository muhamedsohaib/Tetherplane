import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import {
  createBrowserUnifiedHandler,
  startBrowserUnifiedRpcServer,
} from "../../scripts/browser-unified-rpc-host.mjs";

const token = "local-secret-token-for-browser-test-only";
const make = (type, op, args = {}) => ({
  type,
  request_id: "req_1",
  token,
  ...(op ? { capability: "browser." + op, arguments: args } : {}),
});
const success = (request, data) => ({
  request_id: request.request_id,
  status: "success",
  data,
  verification: "not_applicable",
});
const denial = (request, code = "permission_denied") => ({
  request_id: request.request_id,
  status: "error",
  error: { code, message: "site owner did not approve", details: {} },
  verification: "failed",
});
const cdppage = { page_id: "cdp:ABC123", ownership: "tetherplane",
  url: "https://example.org/", backend: "cdp", active: false };
const approved = { page_id: "tab:44", ownership: "shared-authorized",
  url: "https://example.org/", backend: "extension", active: true };
const hidden = { page_id: "tab:45", ownership: "human",
  url: "https://private.example/", backend: "extension", active: true };

function fixture({ ownerOnline = true, managedOnline = true } = {}) {
  const calls = [];
  const handler = createBrowserUnifiedHandler({
    agentToken: token,
    upstream: async ({ port, request }) => {
      calls.push({ port, op: request.capability ?? request.type,
        pageId: request.arguments?.page_id });
      if (port === 17657 && !ownerOnline) throw new Error("owner offline");
      if (port === 17655 && !managedOnline) throw new Error("cdp offline");
      if (request.type === "handshake") {
        return success(request, { operations: ["pages", "snapshot"] });
      }
      if (request.capability === "browser.pages") {
        return success(request, {
          pages: port === 17655
            ? [cdppage, { ...cdppage, ownership: "human", page_id: "cdp:AABB" }]
            : [approved, hidden, { ...approved, page_id: "cdp:BADD" }],
        });
      }
      if (request.capability === "browser.status") {
        return success(request, { available: true, mode: "background_only" });
      }
      if (request.arguments?.page_id === "tab:45") {
        return denial(request);
      }
      return success(request, {
        route: port === 17655 ? "managed" : "owner",
        page_id: request.arguments?.page_id ?? null,
      });
    },
  });
  return { handler, calls };
}

test("handshake requires constant-time comparable exact local token", async () => {
  const { handler } = fixture();
  for (const invalid of ["wrong-secret-token", undefined, null, 14]) {
    const r = await handler({ ...make("handshake"), token: invalid });
    assert.equal(r.status, "error");
    assert.equal(r.error.code, "permission_denied");
  }
  const r = await handler(make("handshake"));
  assert.equal(r.status, "success");
  assert.ok(r.data.operations.includes("snapshot"));
});

test("handshake requires managed CDP backend; owner offline is nonfatal", async () => {
  const onlyCdp = fixture({ ownerOnline: false });
  assert.equal((await onlyCdp.handler(make("handshake"))).status, "success");
  const none = fixture({ managedOnline: false });
  assert.equal((await none.handler(make("handshake"))).status, "error");
});

test("pages exposes only owned CDP pages and grant-authorized Edge tabs", async () => {
  const { handler, calls } = fixture();
  const r = await handler(make("invoke", "pages"));
  assert.equal(r.status, "success");
  assert.deepEqual(r.data.pages, [cdppage, approved]);
  assert.deepEqual(calls.map(x => x.port), [17655, 17657]);
  assert.ok(!JSON.stringify(r.data).includes("private.example"));
});

test("Edge disconnect removes Edge entries without disconnecting owned browser", async () => {
  const { handler } = fixture({ ownerOnline: false });
  const pages = await handler(make("invoke", "pages"));
  assert.deepEqual(pages.data.pages, [cdppage]);
  const s = await handler(make("invoke", "status"));
  assert.equal(s.data.capabilities.backends.cdp, true);
  assert.equal(s.data.capabilities.backends.owner_extension, false);
});

test("page IDs choose their exact backend; no cross-backend fallback", async () => {
  const { handler, calls } = fixture();
  const a = await handler(make("invoke", "snapshot", { page_id: "tab:44" }));
  const b = await handler(make("invoke", "act", { page_id: "cdp:ABC123" }));
  assert.equal(a.data.route, "owner");
  assert.equal(b.data.route, "managed");
  assert.deepEqual(calls.map(x => x.port), [17657, 17655]);
});

test("unshared owner tab is denied without any managed fallback", async () => {
  const { handler, calls } = fixture();
  const r = await handler(make("invoke", "snapshot", { page_id: "tab:45" }));
  assert.equal(r.error.code, "permission_denied");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].port, 17657);
});

test("offline auth route denies without querying managed backend", async () => {
  const { handler, calls } = fixture({ ownerOnline: false });
  const r = await handler(make("invoke", "snapshot", { page_id: "tab:44" }));
  assert.equal(r.error.code, "capability_unavailable");
  assert.deepEqual(calls.map(x => x.port), [17657]);
});

test("unknown, forged, and missing page IDs deny instead of probing either backend", async () => {
  const { handler, calls } = fixture();
  for (const page_id of ["tab:PRIVATE", "cdp:ABC&K", "chrome-extension://secret", ""]) {
    const r = await handler(make("invoke", "snapshot", { page_id }));
    assert.equal(r.error.code, "permission_denied");
  }
  const missing = await handler(make("invoke", "snapshot", {}));
  assert.equal(missing.error.code, "permission_denied");
  assert.equal(calls.length, 0);
});

test("create_tab defaults to isolated CDP, owner backend needs explicit opt-in", async () => {
  const { handler, calls } = fixture();
  const managed = await handler(make("invoke", "create_tab", { url: "https://example.org/" }));
  assert.equal(managed.data.route, "managed");
  const owner = await handler(make("invoke", "create_tab", {
    url: "https://example.org/", backend: "owner",
  }));
  assert.equal(owner.data.route, "owner");
  assert.deepEqual(calls.map(x => x.port), [17655, 17657]);
});

test("owner backend errors are returned unchanged, not reworded as CDP success", async () => {
  const { handler } = fixture();
  const r = await handler(make("invoke", "close", { page_id: "tab:45" }));
  assert.equal(r.status, "error");
  assert.match(r.error.message, /did not approve/);
});

test("status exposes combined backend readiness, no claimed global attach", async () => {
  const { handler } = fixture();
  const r = await handler(make("invoke", "status"));
  assert.equal(r.data.capabilities.backend, "cdp_plus_owner_authorized_extension");
  assert.equal(r.data.capabilities.backends.cdp, true);
  assert.equal(r.data.capabilities.backends.owner_extension, true);
  assert.ok(r.data.capabilities.unavailable_operations.includes("attach"));
});

test("server is loopback-only; direct TCP requests honor auth", async () => {
  const { handler } = fixture();
  await assert.rejects(
    () => startBrowserUnifiedRpcServer({ host: "0.0.0.0", port: 17660, handler }),
    /loopback/,
  );
  const temp = net.createServer();
  await new Promise(r => temp.listen(0, "127.0.0.1", r));
  const port = temp.address().port;
  await new Promise(r => temp.close(r));
  const server = await startBrowserUnifiedRpcServer({ handler, port });
  try {
    const reply = await new Promise((resolve, reject) => {
      const conn = net.connect({ host: "127.0.0.1", port });
      let response = "";
      conn.on("connect", () => conn.write(JSON.stringify({
        ...make("invoke", "pages"), token: "incorrect",
      }) + "\n"));
      conn.on("data", c => { response += c.toString(); });
      conn.on("end", () => {
        try { resolve(JSON.parse(response)); } catch (err) { reject(err); }
      });
      conn.on("error", reject);
    });
    assert.equal(reply.error.code, "permission_denied");
  } finally {
    await server.close();
  }
});
