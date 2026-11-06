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


test("stalled owner websocket does not block managed tabs beyond the caller deadline", async () => {
  const allSockets = new Set();
  const listen = async server => {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return server.address().port;
  };
  const managed = net.createServer(socket => {
    allSockets.add(socket);
    socket.on("close", () => allSockets.delete(socket));
    socket.on("data", input => {
      const request = JSON.parse(input.toString().split("\n")[0]);
      socket.end(JSON.stringify(success(request,
        request.type === "handshake" ? { operations: ["pages"] } :
        request.capability === "browser.pages" ? { pages: [cdppage] } :
        { available: true })) + "\n");
    });
  });
  const unresponsive = net.createServer(socket => {
    allSockets.add(socket);
    socket.on("close", () => allSockets.delete(socket));
    socket.on("data", () => { /* Authenticated host never replies. */ });
  });
  try {
    const managedPort = await listen(managed);
    const ownerPort = await listen(unresponsive);
    const handler = createBrowserUnifiedHandler({
      agentToken: token, managedPort, ownerPort,
      listTimeoutMs: 200, timeoutMs: 3500,
    });
    const began = Date.now();
    const pages = await handler(make("invoke", "pages"));
    const elapsed = Date.now() - began;
    assert.equal(pages.status, "success");
    assert.deepEqual(pages.data.pages, [cdppage]);
    assert.ok(elapsed < 1300, "owner timeout must not stall CDP: " + elapsed);
    const status = await handler(make("invoke", "status"));
    assert.equal(status.data.capabilities.backends.cdp, true);
    assert.equal(status.data.capabilities.backends.owner_extension, false);
  } finally {
    for (const socket of allSockets) socket.destroy();
    await Promise.all([managed, unresponsive].map(server =>
      new Promise(resolve => server.close(resolve))));
  }
});

test("list timeout cannot exceed the outer RPC deadline", () => {
  assert.throws(() => createBrowserUnifiedHandler({
    agentToken: token, timeoutMs: 3500, listTimeoutMs: 3000,
  }), /shorter than the caller deadline/);
});

test("readiness is not inferred from a live socket when extension pages stall", async () => {
  const seen = [];
  const handler = createBrowserUnifiedHandler({
    agentToken: token,
    listTimeoutMs: 200,
    upstream: async ({ port, request }) => {
      seen.push({ port, op: request.capability });
      if (port === 17657 && request.capability === "browser.pages") {
        throw new Error("worker command loop stalled");
      }
      if (port === 17657 && request.capability === "browser.status") {
        return success(request, { available: true });
      }
      return success(request, { available: true, pages: [cdppage] });
    },
  });
  const status = await handler(make("invoke", "status"));
  assert.equal(status.status, "success");
  assert.equal(status.data.capabilities.backends.cdp, true);
  assert.equal(status.data.capabilities.backends.owner_extension, false);
  assert.ok(seen.some(x => x.port === 17657 && x.op === "browser.pages"));
  assert.ok(!seen.some(x => x.port === 17657 && x.op === "browser.status"));
  assert.ok(!JSON.stringify(status).includes("private.example"));
});


test("shared snapshots receive a longer bounded deadline than page listing", async () => {
  const budgets = [];
  const handler = createBrowserUnifiedHandler({
    agentToken: token,
    timeoutMs: 250,
    listTimeoutMs: 180,
    snapshotTimeoutMs: 850,
    upstream: async ({ port, request, timeoutMs }) => {
      budgets.push({port, operation: request.capability, timeoutMs});
      if (request.capability === "browser.snapshot") {
        await new Promise(resolve => setTimeout(resolve, 350));
        return success(request, { nodes: [], semantic_revision: 1 });
      }
      return success(request, { pages: port === 17655 ? [cdppage] : [approved] });
    },
  });
  const start = Date.now();
  const res = await handler(make("invoke", "snapshot", {page_id: "tab:44"}));
  assert.equal(res.status, "success");
  assert.ok(Date.now() - start >= 300);
  assert.deepEqual(budgets, [{ port: 17657, operation: "browser.snapshot", timeoutMs: 850 }]);

  const pages = await handler(make("invoke", "pages"));
  assert.equal(pages.status, "success");
  assert.ok(budgets.some(b => b.operation === "browser.pages" && b.timeoutMs === 180));
  assert.ok(!JSON.stringify(pages.data).includes("private.example"));
});

test("router snapshot timeout is bounded and returns a typed error", async () => {
  const handler = createBrowserUnifiedHandler({
    agentToken: token,
    timeoutMs: 200,
    listTimeoutMs: 100,
    snapshotTimeoutMs: 400,
    upstream: async ({request}) => {
      if (request.capability === "browser.snapshot") {
        throw new Error("Upstream deadline");
      }
      return success(request, {pages: []});
    },
  });
  const response = await handler(make("invoke", "snapshot", {page_id: "tab:44"}));
  assert.equal(response.status, "error");
  assert.equal(response.error.code, "timeout");
  assert.throws(() => createBrowserUnifiedHandler({
    agentToken: token, timeoutMs: 200, listTimeoutMs: 100,
    snapshotTimeoutMs: 200,
  }), /Snapshot deadline/);
});

test("owner-authorized act and wait use explicit budgets longer than semantic settle", async () => {
  const calls = [];
  const handler = createBrowserUnifiedHandler({
    agentToken: token, timeoutMs: 200, listTimeoutMs: 100,
    snapshotTimeoutMs: 650, actTimeoutMs: 900, waitTimeoutMs: 850,
    upstream: async ({port, request, timeoutMs}) => {
      calls.push({port,op:request.capability,budget:timeoutMs});
      if (request.capability === "browser.act") {
        await new Promise(resolve=>setTimeout(resolve,260));
      }
      return success(request,{performed:true});
    },
  });
  const response=await handler(make("invoke","act",{page_id:"tab:44"}));
  assert.equal(response.status,"success");
  assert.deepEqual(calls,[{port:17657,op:"browser.act",budget:900}]);
  calls.length=0;
  const waiting=await handler(make("invoke","wait",{page_id:"tab:44"}));
  assert.equal(waiting.status,"success");
  assert.deepEqual(calls,[{port:17657,op:"browser.wait",budget:850}]);
  assert.throws(()=>createBrowserUnifiedHandler({
    agentToken:token,timeoutMs:200,listTimeoutMs:100,
    snapshotTimeoutMs:650,actTimeoutMs:200,waitTimeoutMs:850,
  }),/action and wait deadlines/);
});

test("unconfirmed owner action is explicit uncertainty, never CDP fallback", async () => {
  const calls=[];
  const handler=createBrowserUnifiedHandler({
    agentToken:token,
    upstream:async({port,request})=>{
      calls.push({port,operation:request.capability});
      if(request.capability==="browser.act")throw new Error("Upstream deadline");
      return success(request,{pages:[]});
    }
  });
  const response=await handler(make("invoke","act",{page_id:"tab:44"}));
  assert.equal(response.status,"error");
  assert.equal(response.error.code,"action_outcome_unknown");
  assert.match(response.error.message,/may have executed/);
  assert.deepEqual(calls,[{port:17657,operation:"browser.act"}]);
});
