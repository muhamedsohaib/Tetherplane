import assert from "node:assert/strict";
import test from "node:test";

import {
  ChromeOwnershipStore,
  ChromeTabsAdapter,
  loadExtensionLaunchConfig,
} from "../src/chrome-adapter.ts";

class FakeTabsApi {
  readonly tabs = new Map<number, {
    id: number;
    windowId: number;
    url: string;
    active: boolean;
  }>();
  lastCreate: Record<string, unknown> | null = null;
  lastUpdate: { tabId: number; properties: Record<string, unknown> } | null =
    null;

  async query(): Promise<Array<Record<string, unknown>>> {
    return [...this.tabs.values()].map((tab) => ({ ...tab }));
  }

  async get(tabId: number): Promise<Record<string, unknown>> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error("missing tab");
    }
    return { ...tab };
  }

  async create(
    properties: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.lastCreate = { ...properties };
    const id = Math.max(0, ...this.tabs.keys()) + 1;
    const tab = {
      id,
      windowId: 1,
      url: String(properties.url),
      active: properties.active === true,
    };
    this.tabs.set(id, tab);
    return { ...tab };
  }

  async update(
    tabId: number,
    properties: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.lastUpdate = {
      tabId,
      properties: { ...properties },
    };
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error("missing tab");
    }
    if (typeof properties.url === "string") {
      tab.url = properties.url;
    }
    if (typeof properties.active === "boolean") {
      tab.active = properties.active;
    }
    return { ...tab };
  }

  async remove(tabId: number): Promise<void> {
    this.tabs.delete(tabId);
  }
}

class FakeStorage {
  readonly values: Record<string, unknown> = {};

  async get(keys?: string | string[]): Promise<Record<string, unknown>> {
    if (keys === undefined) {
      return { ...this.values };
    }
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requested
        .filter((key) => key in this.values)
        .map((key) => [key, this.values[key]]),
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, items);
  }
}

test("Chrome tabs adapter creates background tabs and maps stable tab metadata", async () => {
  const api = new FakeTabsApi();
  api.tabs.set(7, {
    id: 7,
    windowId: 3,
    url: "https://human.example/",
    active: true,
  });
  const tabs = new ChromeTabsAdapter(api);

  assert.deepEqual(await tabs.list(), [
    {
      id: 7,
      window_id: 3,
      url: "https://human.example/",
      active: true,
    },
  ]);

  const created = await tabs.create({
    url: "https://fixture.example/",
    active: false,
  });
  assert.equal(created.active, false);
  assert.deepEqual(api.lastCreate, {
    url: "https://fixture.example/",
    active: false,
  });
});

test("Chrome ownership store round-trips only Tetherplane page records", async () => {
  const storage = new FakeStorage();
  const store = new ChromeOwnershipStore(storage);
  const records = [
    {
      page_id: "tab:8",
      tab_id: 8,
      window_id: 1,
      url: "https://fixture.example/",
      active: false,
      ownership: "tetherplane" as const,
    },
  ];

  await store.save(records);
  assert.deepEqual(await store.load(), records);
  assert.deepEqual(Object.keys(storage.values), [
    "tetherplane_browser_pages_v1",
  ]);
});

test("launch config accepts loopback websocket only and remains browser-local", async () => {
  const storage = new FakeStorage();
  storage.values.tetherplane_bridge_url =
    "ws://127.0.0.1:8123/extension";
  storage.values.tetherplane_launch_token = "ephemeral-launch-token";

  assert.deepEqual(await loadExtensionLaunchConfig(storage), {
    bridge_url: "ws://127.0.0.1:8123/extension",
    launch_token: "ephemeral-launch-token",
  });

  storage.values.tetherplane_bridge_url =
    "ws://remote.example:8123/extension";
  await assert.rejects(
    () => loadExtensionLaunchConfig(storage),
    /loopback/i,
  );
});

test("saving launch config writes only loopback URL and ephemeral token to supplied session storage", async () => {
  const storage = new FakeStorage();
  const {
    saveExtensionLaunchConfig,
  } = await import("../src/chrome-adapter.ts");

  await saveExtensionLaunchConfig(storage, {
    bridge_url: "ws://127.0.0.1:8123/extension",
    launch_token: "ephemeral-token",
  });

  assert.deepEqual(storage.values, {
    tetherplane_bridge_url: "ws://127.0.0.1:8123/extension",
    tetherplane_launch_token: "ephemeral-token",
  });

  await assert.rejects(
    () =>
      saveExtensionLaunchConfig(storage, {
        bridge_url: "ws://remote.example:8123/extension",
        launch_token: "should-not-write",
      }),
    /loopback/i,
  );
  assert.equal(
    storage.values.tetherplane_launch_token,
    "ephemeral-token",
  );
});
