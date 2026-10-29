import assert from "node:assert/strict";
import test from "node:test";

import { BrowserPolicyError } from "@tetherplane/browser-bridge";

import {
  ExtensionTabController,
  type ExtensionOwnershipStore,
  type ExtensionTab,
  type ExtensionTabsAdapter,
} from "../src/index.ts";

class FakeTabs implements ExtensionTabsAdapter {
  readonly tabs = new Map<number, ExtensionTab>();
  activeTabId: number | null = null;
  nextId = 1;
  lastCreate: { url: string; active: boolean } | null = null;
  lastUpdate:
    | { tabId: number; properties: { url?: string; active?: boolean } }
    | null = null;

  constructor(initial: ExtensionTab[] = []) {
    for (const tab of initial) {
      this.tabs.set(tab.id, structuredClone(tab));
      this.nextId = Math.max(this.nextId, tab.id + 1);
      if (tab.active) {
        this.activeTabId = tab.id;
      }
    }
  }

  async list(): Promise<ExtensionTab[]> {
    return [...this.tabs.values()].map((tab) => structuredClone(tab));
  }

  async get(tabId: number): Promise<ExtensionTab | null> {
    const tab = this.tabs.get(tabId);
    return tab ? structuredClone(tab) : null;
  }

  async create(properties: {
    url: string;
    active: boolean;
  }): Promise<ExtensionTab> {
    this.lastCreate = structuredClone(properties);
    const id = this.nextId++;
    if (properties.active) {
      this.#setActive(id);
    }
    const tab: ExtensionTab = {
      id,
      window_id: 1,
      url: properties.url,
      active: properties.active,
    };
    this.tabs.set(id, tab);
    return structuredClone(tab);
  }

  async update(
    tabId: number,
    properties: { url?: string; active?: boolean },
  ): Promise<ExtensionTab> {
    this.lastUpdate = {
      tabId,
      properties: structuredClone(properties),
    };
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error("missing tab");
    }
    if (properties.url !== undefined) {
      tab.url = properties.url;
    }
    if (properties.active === true) {
      this.#setActive(tabId);
      tab.active = true;
    }
    return structuredClone(tab);
  }

  async remove(tabId: number): Promise<void> {
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
    }
  }

  #setActive(tabId: number): void {
    for (const tab of this.tabs.values()) {
      tab.active = tab.id === tabId;
    }
    this.activeTabId = tabId;
  }
}

class MemoryStore implements ExtensionOwnershipStore {
  records: Awaited<ReturnType<ExtensionOwnershipStore["load"]>> = [];

  async load() {
    return structuredClone(this.records);
  }

  async save(records: typeof this.records): Promise<void> {
    this.records = structuredClone(records);
  }
}

function humanTab(): ExtensionTab {
  return {
    id: 1,
    window_id: 1,
    url: "https://human.example/",
    active: true,
  };
}

test("creates Tetherplane-owned tab in background without changing active human tab", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const store = new MemoryStore();
  const controller = new ExtensionTabController({ tabs, store });
  await controller.initialize();
  await controller.approveOwnedOriginFromTab(1, {
    ttl_ms: 60_000, operations: ["act", "navigate"],
  });

  const created = await controller.createOwnedTab(
    "https://human.example/editor",
  );

  assert.equal(created.ownership, "tetherplane");
  assert.equal(created.active, false);
  assert.equal(tabs.activeTabId, 1);
  assert.deepEqual(tabs.lastCreate, {
    url: "https://human.example/editor",
    active: false,
  });
});

test("navigates owned background tab without activating it", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const controller = new ExtensionTabController({
    tabs,
    store: new MemoryStore(),
  });
  await controller.initialize();
  await controller.approveOwnedOriginFromTab(1, {
    ttl_ms: 60_000, operations: ["act", "navigate"],
  });
  const created = await controller.createOwnedTab(
    "https://human.example/one",
  );

  const navigated = await controller.navigate(
    created.page_id,
    "https://human.example/two",
  );

  assert.equal(navigated.url, "https://human.example/two");
  assert.equal(tabs.activeTabId, 1);
  assert.deepEqual(tabs.lastUpdate, {
    tabId: created.tab_id,
    properties: {
      url: "https://human.example/two",
    },
  });
});

test("human-owned tab cannot be navigated or closed by extension controller", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const controller = new ExtensionTabController({
    tabs,
    store: new MemoryStore(),
  });
  await controller.initialize();

  for (const operation of ["navigate", "close"] as const) {
    await assert.rejects(
      () =>
        operation === "navigate"
          ? controller.navigate("tab:1", "https://blocked.example/")
          : controller.close("tab:1"),
      (error: unknown) =>
        error instanceof BrowserPolicyError &&
        error.code === "permission_denied",
    );
  }

  assert.equal(tabs.activeTabId, 1);
  assert.equal((await tabs.get(1))?.url, "https://human.example/");
});

test("agent-owned tab becomes human-owned after controller restart without site reapproval", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const store = new MemoryStore();
  const first = new ExtensionTabController({ tabs, store });
  await first.initialize();
  await first.approveOwnedOriginFromTab(1, {
    ttl_ms: 60_000, operations: ["act", "navigate"],
  });
  const created = await first.createOwnedTab(
    "https://human.example/editor",
  );

  const restarted = new ExtensionTabController({ tabs, store });
  await restarted.initialize();

  const restored = restarted
    .pages()
    .find((page) => page.page_id === created.page_id);
  assert.equal(restored?.ownership, "human");
  assert.equal(restored?.tab_id, created.tab_id);
  assert.equal(tabs.activeTabId, 1);
});


test("attached human tab expires back to human ownership", async () => {
  let now = 1_000;
  const tabs = new FakeTabs([humanTab()]);
  const store = new MemoryStore();
  const controller = new ExtensionTabController({
    tabs,
    store,
    now: () => now,
  });
  await controller.initialize();

  const attached = await controller.attachHumanTab(1, {
    operations: ["navigate"],
    ttl_ms: 1_000,
  });

  assert.equal(attached.ownership, "shared-authorized");
  assert.equal(attached.grant?.expires_at_ms, 2_000);

  now = 2_001;

  await assert.rejects(
    () =>
      controller.navigate(
        "tab:1",
        "https://blocked-after-expiry.example/",
      ),
    (error: unknown) =>
      error instanceof BrowserPolicyError &&
      error.code === "permission_denied",
  );

  const expired = controller
    .pages()
    .find((page) => page.page_id === "tab:1");
  assert.equal(expired?.ownership, "human");
  assert.equal(expired?.grant, undefined);
  assert.equal(tabs.activeTabId, 1);
});

test("detachHumanTab immediately revokes mutation and navigation authority", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const store = new MemoryStore();
  const controller = new ExtensionTabController({
    tabs,
    store,
  });
  await controller.initialize();

  const attached = await controller.attachHumanTab(1, {
    operations: ["navigate"],
    ttl_ms: 60_000,
  });
  assert.equal(attached.ownership, "shared-authorized");

  const navigated = await controller.navigate(
    "tab:1",
    "https://human.example/permitted",
  );
  assert.equal(navigated.url, "https://human.example/permitted");

  const detached = await controller.detachHumanTab(1);
  assert.equal(detached.ownership, "human");
  assert.equal(detached.grant, undefined);

  await assert.rejects(
    () =>
      controller.navigate(
        "tab:1",
        "https://blocked-after-detach.example/",
      ),
    (error: unknown) =>
      error instanceof BrowserPolicyError &&
      error.code === "permission_denied",
  );

  const current = controller
    .pages()
    .find((page) => page.page_id === "tab:1");
  assert.equal(current?.ownership, "human");
  assert.equal(current?.grant, undefined);
});

test("detached human tab remains human across service-worker controller restart", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const store = new MemoryStore();
  const first = new ExtensionTabController({
    tabs,
    store,
  });
  await first.initialize();

  await first.attachHumanTab(1, {
    operations: ["navigate"],
    ttl_ms: 60_000,
  });
  await first.detachHumanTab(1);

  const restarted = new ExtensionTabController({
    tabs,
    store,
  });
  await restarted.initialize();

  const page = restarted
    .pages()
    .find((p) => p.page_id === "tab:1");
  assert.equal(page?.ownership, "human");
  assert.equal(page?.grant, undefined);

  await assert.rejects(
    () =>
      restarted.navigate(
        "tab:1",
        "https://blocked-after-restart.example/",
      ),
    (error: unknown) =>
      error instanceof BrowserPolicyError &&
      error.code === "permission_denied",
  );
});


test("owner sharing pins the live origin and blocks a cross-origin navigation", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const controller = new ExtensionTabController({ tabs, store: new MemoryStore() });
  await controller.initialize();
  const shared = await controller.attachHumanTab(1, {
    operations: ["act", "navigate"],
    ttl_ms: 60_000,
  });
  assert.equal(shared.grant?.origin, "https://human.example");

  await assert.rejects(
    () => controller.navigate("tab:1", "https://human.example.evil.test/"),
    (error: unknown) => error instanceof BrowserPolicyError &&
      error.code === "permission_denied",
  );
  assert.equal(tabs.lastUpdate, null, "forbidden origin reached chrome.tabs.update");

  const sameOrigin = await controller.navigate("tab:1", "https://human.example/next");
  assert.equal(sameOrigin.url, "https://human.example/next");
});

test("silent cross-origin browser redirect revokes previously shared tab", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const store = new MemoryStore();
  const controller = new ExtensionTabController({ tabs, store });
  await controller.initialize();
  await controller.attachHumanTab(1, {
    operations: ["act", "navigate"], ttl_ms: 60_000,
  });
  tabs.tabs.get(1)!.url = "https://unapproved.test/landing";

  await assert.rejects(
    () => controller.navigate("tab:1", "https://human.example/return"),
    (error: unknown) => error instanceof BrowserPolicyError &&
      error.code === "permission_denied",
  );
  assert.equal(tabs.lastUpdate, null);
  assert.equal(controller.pages().find(p => p.tab_id === 1)?.ownership, "human");
  const persisted = store.records.find(p => p.tab_id === 1);
  assert.equal(persisted?.ownership, "human", "old grant survived revocation");
  assert.equal(persisted?.grant, undefined);
});

test("browser restart cannot resurrect a grant after origin redirect", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const store = new MemoryStore();
  const first = new ExtensionTabController({ tabs, store });
  await first.initialize();
  await first.attachHumanTab(1, { operations: ["act"], ttl_ms: 60_000 });
  tabs.tabs.get(1)!.url = "https://other-account.test/";
  const restarted = new ExtensionTabController({ tabs, store });
  await restarted.initialize();
  const page = restarted.pages().find(p => p.tab_id === 1);
  assert.equal(page?.ownership, "human");
  assert.equal(page?.grant, undefined);
});


test("agent-created tab cannot open any origin without a locally approved site grant", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const controller = new ExtensionTabController({ tabs, store: new MemoryStore() });
  await controller.initialize();
  await assert.rejects(
    () => controller.createOwnedTab("https://other.example/private"),
    (e: unknown) => e instanceof BrowserPolicyError && e.code === "permission_denied",
  );
  assert.equal(tabs.lastCreate, null, "denied URL reached real tab-creation boundary");
});

test("locally approved site permits only its exact origin for new agent tabs", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const controller = new ExtensionTabController({ tabs, store: new MemoryStore() });
  await controller.initialize();
  // The site origin is obtained from the actual owner tab, never an agent URL.
  await controller.approveOwnedOriginFromTab(1, {
    ttl_ms: 60_000, operations: ["act", "navigate"],
  });
  const page = await controller.createOwnedTab("https://human.example/project");
  assert.equal(page.ownership, "tetherplane");
  assert.equal(page.grant?.origin, "https://human.example");
  await assert.rejects(
    () => controller.createOwnedTab("https://human.example.attacker.test/private"),
    (e: unknown) => e instanceof BrowserPolicyError && e.code === "permission_denied",
  );
  await assert.rejects(
    () => controller.navigate(page.page_id, "https://other.example/private"),
    (e: unknown) => e instanceof BrowserPolicyError && e.code === "permission_denied",
  );
  assert.equal((await tabs.get(page.tab_id))?.url, "https://human.example/project");
});

test("owner revoking a site blocks already-created agent tab actions", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const controller = new ExtensionTabController({ tabs, store: new MemoryStore() });
  await controller.initialize();
  await controller.approveOwnedOriginFromTab(1, {
    ttl_ms: 60_000, operations: ["act", "navigate"],
  });
  const page = await controller.createOwnedTab("https://human.example/inside");
  await controller.revokeOwnedOriginFromTab(1);
  await assert.rejects(
    () => controller.authorizeLivePage(page.page_id, "act"),
    (e: unknown) => e instanceof BrowserPolicyError && e.code === "permission_denied",
  );
  await assert.rejects(
    () => controller.createOwnedTab("https://human.example/inside"),
    (e: unknown) => e instanceof BrowserPolicyError && e.code === "permission_denied",
  );
});


test("an uncommitted agent-owned about:blank tab is denied without permanently losing its site grant", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const controller = new ExtensionTabController({tabs, store:new MemoryStore()});
  await controller.initialize();
  await controller.approveOwnedOriginFromTab(1, {
    ttl_ms:60_000, operations:["act","navigate"],
  });
  const created = await controller.createOwnedTab("https://human.example/ready");
  tabs.tabs.get(created.tab_id)!.url = "about:blank";
  await assert.rejects(
    () => controller.authorizeLivePage(created.page_id, "snapshot"),
    (e:unknown) => e instanceof BrowserPolicyError && e.code === "permission_denied",
  );
  // The site approval is still live; the initial navigation has not committed.
  tabs.tabs.get(created.tab_id)!.url = "https://human.example/ready";
  const approved = await controller.authorizeLivePage(created.page_id, "snapshot");
  assert.equal(approved.ownership, "tetherplane");
  assert.equal(approved.url, "https://human.example/ready");
});
