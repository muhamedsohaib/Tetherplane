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

  const created = await controller.createOwnedTab(
    "https://fixture.example/editor",
  );

  assert.equal(created.ownership, "tetherplane");
  assert.equal(created.active, false);
  assert.equal(tabs.activeTabId, 1);
  assert.deepEqual(tabs.lastCreate, {
    url: "https://fixture.example/editor",
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
  const created = await controller.createOwnedTab(
    "https://fixture.example/one",
  );

  const navigated = await controller.navigate(
    created.page_id,
    "https://fixture.example/two",
  );

  assert.equal(navigated.url, "https://fixture.example/two");
  assert.equal(tabs.activeTabId, 1);
  assert.deepEqual(tabs.lastUpdate, {
    tabId: created.tab_id,
    properties: {
      url: "https://fixture.example/two",
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

test("owned-tab identity survives service-worker controller restart", async () => {
  const tabs = new FakeTabs([humanTab()]);
  const store = new MemoryStore();
  const first = new ExtensionTabController({ tabs, store });
  await first.initialize();
  const created = await first.createOwnedTab(
    "https://fixture.example/editor",
  );

  const restarted = new ExtensionTabController({ tabs, store });
  await restarted.initialize();

  const restored = restarted
    .pages()
    .find((page) => page.page_id === created.page_id);
  assert.equal(restored?.ownership, "tetherplane");
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
