import assert from "node:assert/strict";
import test from "node:test";

import {
  CdpLabOnlyBridgeService,
  requireLoopbackLabOrigin,
} from "../src/cdp-lab-service.ts";
import type {
  BrowserServiceBackend,
  BrowserServicePage,
} from "../src/rpc-server.ts";

const origin = "http://127.0.0.1:49123";

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
