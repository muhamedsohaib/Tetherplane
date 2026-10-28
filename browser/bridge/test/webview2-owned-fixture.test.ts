import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserOwnershipRegistry,
  SemanticSnapshotEngine,
  VerifiedActionEngine,
} from "../src/index.ts";
import {
  WebView2OwnedFixtureBackend,
  type WebView2OwnedFixtureTransport,
} from "../src/webview2-owned-fixture.ts";

const PAGE = "wvlab:owned-9a64";
const LOCAL_URL = "about:blank";

class NativeFixture implements WebView2OwnedFixtureTransport {
  readonly calls: string[] = [];
  status = "initial";
  revision = 1;
  open = false;
  async request(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push(method);
    if (method === "create_fixture") {
      this.open = true;
      return { page_id: PAGE, url: LOCAL_URL };
    }
    if (args.page_id !== PAGE || !this.open) {
      return { error: { code: "permission_denied" } };
    }
    if (method === "observe_fixture") {
      return { page_id: PAGE, url: LOCAL_URL, status: this.status, revision: this.revision };
    }
    if (method === "click_fixture") {
      if (args.element !== "go") return { error: { code: "permission_denied" } };
      this.status = "clicked";
      this.revision++;
      return { clicked: true };
    }
    if (method === "close_fixture") {
      this.open = false;
      return { closed: true };
    }
    return { error: { code: "capability_unavailable" } };
  }
}

function setup() {
  const native = new NativeFixture();
  let time = 1000;
  const backend = new WebView2OwnedFixtureBackend({
    transport: native,
    expiresAtMs: 5000,
    clock: () => time,
  });
  return { backend, native, expire: () => { time = 6000; } };
}

test("WebView2 fixture exposes only actual supported capabilities, not uploads or remote navigation", async () => {
  const { backend } = setup();
  assert.deepEqual(backend.capabilities().operations, ["create_fixture", "snapshot", "click", "close"]);
  assert.ok(!backend.capabilities().operations.includes("upload"));
});

test("owned WebView2 local page can be verified using Tetherplane VerifiedActionEngine", async () => {
  const { backend, native } = setup();
  const page = await backend.createPage();
  assert.equal(page.page_id, PAGE);
  assert.equal(page.url, LOCAL_URL);
  assert.equal(page.ownership, "tetherplane");
  assert.equal(page.active, false);
  const before = await backend.observe(page.page_id);
  const semantics = new SemanticSnapshotEngine();
  const save = semantics.snapshot(before.nodes, { revision: before.semantic_revision })
    .nodes.find((node) => node.role === "button" && node.accessible_name === "GO");
  assert.ok(save?.ref);
  const ownership = new BrowserOwnershipRegistry();
  ownership.register({ page_id: page.page_id, ownership: "tetherplane", active: false });
  const engine = new VerifiedActionEngine({ backend, ownership, semantics });
  const result = await engine.execute({
    page_id: page.page_id,
    mode: "background_only",
    actions: [{ kind: "click", target: save.ref }],
    expectations: [{ kind: "text", includes: "clicked" }],
  });
  assert.equal(result.state, "verified");
  assert.ok(result.after_semantic_revision > result.before_semantic_revision);
  assert.equal(native.status, "clicked");
  await backend.closePage(page.page_id);
  await assert.rejects(backend.observe(page.page_id), { code: "permission_denied" });
});

test("foreign page, unsupported action, and external URL are denied before native calls", async () => {
  const { backend, native } = setup();
  const page = await backend.createPage();
  const calls = native.calls.length;
  await assert.rejects(backend.observe("wvlab:human-private"), { code: "permission_denied" });
  await assert.rejects(
    backend.perform(page.page_id, { kind: "navigate", url: "https://example.com/" }),
    { code: "capability_unavailable" },
  );
  await assert.rejects(
    backend.perform(page.page_id, { kind: "click", backend_id: "css:#password" }),
    { code: "permission_denied" },
  );
  assert.equal(native.calls.length, calls);
  assert.equal(native.status, "initial");
});

test("local expiry and revocation deny new actions without asking native browser to mutate", async () => {
  const x = setup();
  const page = await x.backend.createPage();
  const count = x.native.calls.length;
  x.expire();
  await assert.rejects(x.backend.perform(page.page_id, { kind: "click", backend_id: "fixture:go" }), { code: "permission_denied" });
  assert.equal(x.native.calls.length, count);
  const y = setup();
  const another = await y.backend.createPage();
  y.backend.revoke();
  const calls = y.native.calls.length;
  await assert.rejects(y.backend.observe(another.page_id), { code: "permission_denied" });
  assert.equal(y.native.calls.length, calls);
});

test("host refusal or malformed page identity is not silently accepted", async () => {
  const untrusted: WebView2OwnedFixtureTransport = {
    async request() { return { page_id: "human:tab-1", url: "about:blank" }; },
  };
  const backend = new WebView2OwnedFixtureBackend({ transport: untrusted, expiresAtMs: Date.now() + 2000 });
  await assert.rejects(backend.createPage(), { code: "provider_failure" });
});


test("revocation during native page creation rejects and closes the newly created fixture", async () => {
  let finishCreate: ((value: Record<string, unknown>) => void) | undefined;
  const calls: string[] = [];
  const native: WebView2OwnedFixtureTransport = {
    async request(method, args) {
      calls.push(method);
      if (method === "create_fixture") {
        return await new Promise<Record<string, unknown>>((resolve) => { finishCreate = resolve; });
      }
      if (method === "close_fixture" && args.page_id === PAGE) return { closed: true };
      throw new Error("unexpected native request");
    },
  };
  const backend = new WebView2OwnedFixtureBackend({ transport: native, expiresAtMs: Date.now() + 5000 });
  const creating = backend.createPage();
  assert.ok(finishCreate, "native create must have started");
  backend.revoke();
  finishCreate({ page_id: PAGE, url: "about:blank" });
  await assert.rejects(creating, { code: "permission_denied" });
  assert.deepEqual(calls, ["create_fixture", "close_fixture"]);
});
