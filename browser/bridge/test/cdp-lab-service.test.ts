import assert from "node:assert/strict";
import test from "node:test";

import {
  CdpLabOnlyBridgeService,
  requireLoopbackLabOrigin,
} from "../src/cdp-lab-service.ts";
import {
  GRANTABLE_LAB_OPERATIONS,
  LocalBrowserLabGrant,
  type GrantableLabOperation,
} from "../src/local-lab-grant.ts";
import type {
  BrowserServiceBackend,
  BrowserServicePage,
} from "../src/rpc-server.ts";

const origin = "http://127.0.0.1:49123";

function labGrant(
  operations: readonly GrantableLabOperation[] = GRANTABLE_LAB_OPERATIONS,
): LocalBrowserLabGrant {
  return new LocalBrowserLabGrant({
    origin,
    operations,
    expiresAtMs: Date.now() + 5 * 60_000,
  });
}

class FakeBrowser implements BrowserServiceBackend {
  pagesState: BrowserServicePage[] = [
    {
      page_id: "human:personal",
      ownership: "human",
      active: true,
      url: "https://personal.example/account",
    },
  ];
  writes = 0;
  closes: string[] = [];
  redirectTo: string | null = null;

  capabilities() {
    return { backend: "cdp", operations: ["pages", "act", "upload"] };
  }

  async pages() {
    return structuredClone(this.pagesState);
  }

  async createTab(url: string) {
    const page: BrowserServicePage = {
      page_id: "cdp:owned-test",
      ownership: "tetherplane",
      active: false,
      url,
    };
    this.pagesState.push(page);
    this.writes += 1;
    return structuredClone(page);
  }

  async navigate(pageId: string, url: string) {
    const page = this.pagesState.find((item) => item.page_id === pageId)!;
    page.url = this.redirectTo ?? url;
    this.writes += 1;
    return structuredClone(page);
  }

  async close(pageId: string) {
    this.closes.push(pageId);
    this.pagesState = this.pagesState.filter((page) => page.page_id !== pageId);
  }

  async observe(pageId: string) {
    return {
      page_id: pageId,
      url: this.pagesState.find((page) => page.page_id === pageId)!.url,
      semantic_revision: 1,
      resource_revision: "1",
      nodes: [],
      validation_messages: [],
      toasts: [],
    };
  }

  async perform() {
    this.writes += 1;
  }

  async waitForSettled(pageId: string) {
    return this.observe(pageId);
  }

  async uploadFile() {
    this.writes += 1;
  }

  async downloads() {
    return [];
  }

  async diagnostics() {
    return [];
  }
}

test("local CDP laboratory never accepts a public or default-profile origin", () => {
  assert.equal(requireLoopbackLabOrigin(origin), origin);
  assert.equal(
    requireLoopbackLabOrigin("http://localhost:49123"),
    "http://localhost:49123",
  );
  for (const candidate of [
    "https://example.com",
    "https://127.0.0.1:49123",
    "http://localhost.example.com:49123",
    "http://127.0.0.1.evil.example:49123",
    "http://127.0.0.1",
    "http://127.0.0.1:49123/private",
    "http://owner:password@127.0.0.1:49123",
    "file:///etc/passwd",
    "http://127.0.0.1:49123/?secret=1",
    "",
  ]) {
    assert.throws(() => requireLoopbackLabOrigin(candidate), TypeError);
  }
});

test("lab CDP handshake operations exclude file upload and global downloads", () => {
  const backend = new FakeBrowser();
  const service = new CdpLabOnlyBridgeService({
    backend,
    labOrigin: origin,
    grant: labGrant(),
  });

  assert.deepEqual(service.operations(), [
    "status",
    "pages",
    "create_tab",
    "snapshot",
    "navigate",
    "close",
    "act",
    "wait",
  ]);
});

test("model cannot create public tabs or impersonate human browser ownership", async () => {
  const backend = new FakeBrowser();
  const service = new CdpLabOnlyBridgeService({
    backend,
    labOrigin: origin,
    grant: labGrant(),
  });

  await assert.rejects(
    service.invoke("browser.create_tab", { url: "https://example.com/" }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "permission_denied",
  );
  await assert.rejects(
    service.invoke("browser.snapshot", {
      page_id: "human:personal",
      ownership: "tetherplane",
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "permission_denied",
  );
  assert.equal(backend.writes, 0);
  assert.deepEqual(
    (await service.invoke("browser.pages", {})).data,
    { pages: [] },
  );

  const created = await service.invoke("browser.create_tab", {
    url: `${origin}/editor`,
  });
  const page = created.data as BrowserServicePage;
  assert.equal(page.ownership, "tetherplane");
  const pages = await service.invoke("browser.pages", {});
  assert.deepEqual(
    (pages.data as { pages: BrowserServicePage[] }).pages.map((p) => p.page_id),
    ["cdp:owned-test"],
  );
  assert.equal(backend.writes, 1);

  await assert.rejects(
    service.invoke("browser.navigate", {
      page_id: page.page_id,
      url: "http://127.0.0.1:49124/other",
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "permission_denied",
  );
  await assert.rejects(
    service.invoke("browser.upload", {
      page_id: page.page_id,
      file_path: "C:\\private\\token.txt",
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "permission_denied",
  );
  assert.equal(backend.writes, 1);
});

test("a redirected lab page is closed and never reported as authorized", async () => {
  const backend = new FakeBrowser();
  const service = new CdpLabOnlyBridgeService({
    backend,
    labOrigin: origin,
    grant: labGrant(),
  });
  await service.invoke("browser.create_tab", { url: origin });
  backend.redirectTo = "https://outside.example/after-redirect";

  await assert.rejects(
    service.invoke("browser.navigate", {
      page_id: "cdp:owned-test",
      url: `${origin}/fixture`,
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "permission_denied",
  );
  assert.deepEqual(backend.closes, ["cdp:owned-test"]);
  assert.deepEqual((await service.invoke("browser.pages", {})).data, {
    pages: [],
  });
});


test("nested browser.act navigation is denied before any earlier action executes", async () => {
  const backend = new FakeBrowser();
  const service = new CdpLabOnlyBridgeService({
    backend,
    labOrigin: origin,
    grant: labGrant(),
  });
  await service.invoke("browser.create_tab", { url: origin });
  assert.equal(backend.writes, 1);

  // A malicious caller could previously put a navigation inside a
  // multi-action request, bypassing browser.navigate's origin guard.
  await assert.rejects(
    service.invoke("browser.act", {
      page_id: "cdp:owned-test",
      mode: "background_only",
      actions: [
        { kind: "click", target: { ref_id: "fake" } },
        { kind: "navigate", url: "https://unapproved.example/" },
      ],
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "permission_denied",
  );
  assert.equal(
    backend.writes,
    1,
    "no action from an unsafe batch may execute",
  );
});

test("local grant revocation immediately denies every browser action and hides pages", async () => {
  const backend = new FakeBrowser();
  const grant = labGrant();
  const service = new CdpLabOnlyBridgeService({
    backend,
    labOrigin: origin,
    grant,
  });
  await service.invoke("browser.create_tab", { url: origin });
  grant.revoke();

  assert.deepEqual(service.operations(), ["status"]);
  const status = await service.invoke("browser.status", {});
  assert.equal((status.data as Record<string, unknown>).available, false);

  for (const [operation, args] of [
    ["browser.pages", {}],
    ["browser.snapshot", { page_id: "cdp:owned-test" }],
    ["browser.navigate", { page_id: "cdp:owned-test", url: origin }],
    ["browser.act", { page_id: "cdp:owned-test", actions: [] }],
    ["browser.close", { page_id: "cdp:owned-test" }],
  ] as const) {
    await assert.rejects(
      service.invoke(operation, args),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "permission_denied",
    );
  }
  assert.equal(backend.writes, 1, "revoked grants cause no mutations");
});

test("grant scope cannot be changed through model RPC or a mismatched origin", async () => {
  const backend = new FakeBrowser();
  const grant = labGrant(["pages", "create_tab"]);
  const service = new CdpLabOnlyBridgeService({
    backend,
    labOrigin: origin,
    grant,
  });
  await assert.rejects(
    service.invoke("browser.grant", {
      origin: "https://amazon.example",
      operations: ["act", "navigate"],
      expires_at_ms: Date.now() + 600_000,
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "permission_denied",
  );
  await service.invoke("browser.create_tab", { url: origin });
  await assert.rejects(
    service.invoke("browser.act", {
      page_id: "cdp:owned-test",
      actions: [{ kind: "click", target: { ref_id: "fake" } }],
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "permission_denied",
  );
  assert.throws(
    () => new CdpLabOnlyBridgeService({
      backend,
      labOrigin: origin,
      grant: new LocalBrowserLabGrant({
        origin: "https://unauthorized.example",
        operations: ["pages"],
        expiresAtMs: Date.now() + 60_000,
      }),
    }),
    /local grant origin does not match/,
  );
  assert.equal(backend.writes, 1);
});

test("grants expire fail-closed and reject unsafe lifetimes and URL credentials", () => {
  let now = 10_000;
  const clock = () => now;
  const grant = new LocalBrowserLabGrant({
    origin,
    operations: ["pages", "act"],
    expiresAtMs: now + 100,
  }, clock);
  grant.authorize("pages", origin + "/editor");
  assert.equal(grant.allowsUrl(origin + "/editor"), true);
  assert.equal(grant.allowsUrl("http://127.0.0.1:49124/editor"), false);
  assert.equal(grant.allowsUrl("https://amazon.example/"), false);
  assert.equal(grant.allowsUrl("http://user:pass@127.0.0.1:49123/"), false);
  now += 100;
  assert.equal(grant.isActive, false);
  assert.deepEqual(grant.operations(), []);
  assert.throws(
    () => grant.authorize("pages", origin),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === "permission_denied",
  );
  assert.throws(
    () => new LocalBrowserLabGrant({
      origin,
      operations: ["pages"],
      expiresAtMs: now + 16 * 60_000,
    }, clock),
    TypeError,
  );
});
