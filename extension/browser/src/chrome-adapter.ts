import type {
  ExtensionOwnershipStore,
  ExtensionPageRecord,
  ExtensionTab,
  ExtensionTabsAdapter,
} from "./index.ts";

type ChromeTabLike = {
  id?: number;
  windowId?: number;
  url?: string;
  active?: boolean;
};

export type ChromeTabsApi = {
  query(queryInfo?: Record<string, unknown>): Promise<ChromeTabLike[]>;
  get(tabId: number): Promise<ChromeTabLike>;
  create(
    properties: Record<string, unknown>,
  ): Promise<ChromeTabLike>;
  update(
    tabId: number,
    properties: Record<string, unknown>,
  ): Promise<ChromeTabLike>;
  remove(tabId: number): Promise<void>;
};

export type ChromeStorageArea = {
  get(keys?: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

const OWNERSHIP_KEY = "tetherplane_browser_pages_v1";
const BRIDGE_URL_KEY = "tetherplane_bridge_url";
const LAUNCH_TOKEN_KEY = "tetherplane_launch_token";

export class ChromeTabsAdapter implements ExtensionTabsAdapter {
  readonly #tabs: ChromeTabsApi;

  constructor(tabs: ChromeTabsApi) {
    this.#tabs = tabs;
  }

  async list(): Promise<ExtensionTab[]> {
    const tabs = await this.#tabs.query({});
    return tabs
      .map(toExtensionTab)
      .filter((tab): tab is ExtensionTab => tab !== null);
  }

  async get(tabId: number): Promise<ExtensionTab | null> {
    try {
      return toExtensionTab(await this.#tabs.get(tabId));
    } catch {
      return null;
    }
  }

  async create(properties: {
    url: string;
    active: boolean;
  }): Promise<ExtensionTab> {
    const tab = toExtensionTab(
      await this.#tabs.create({
        url: properties.url,
        active: properties.active,
      }),
    );
    if (!tab) {
      throw new Error("Chrome returned a tab without a stable ID");
    }
    return tab;
  }

  async update(
    tabId: number,
    properties: {
      url?: string;
      active?: boolean;
    },
  ): Promise<ExtensionTab> {
    const tab = toExtensionTab(
      await this.#tabs.update(tabId, {
        ...(properties.url !== undefined
          ? { url: properties.url }
          : {}),
        ...(properties.active !== undefined
          ? { active: properties.active }
          : {}),
      }),
    );
    if (!tab) {
      throw new Error("Chrome returned a tab without a stable ID");
    }
    return tab;
  }

  async remove(tabId: number): Promise<void> {
    await this.#tabs.remove(tabId);
  }
}

export class ChromeOwnershipStore implements ExtensionOwnershipStore {
  readonly #storage: ChromeStorageArea;

  constructor(storage: ChromeStorageArea) {
    this.#storage = storage;
  }

  async load(): Promise<ExtensionPageRecord[]> {
    const values = await this.#storage.get(OWNERSHIP_KEY);
    const raw = values[OWNERSHIP_KEY];
    if (!Array.isArray(raw)) {
      return [];
    }

    return raw
      .filter(isPersistedPageRecord)
      .map((record) => structuredClone(record));
  }

  async save(records: ExtensionPageRecord[]): Promise<void> {
    const persisted = records.filter(
      (record) => record.ownership !== "human",
    );
    await this.#storage.set({
      [OWNERSHIP_KEY]: structuredClone(persisted),
    });
  }
}

export type ExtensionLaunchConfig = {
  bridge_url: string;
  launch_token: string;
};

export async function loadExtensionLaunchConfig(
  storage: ChromeStorageArea,
): Promise<ExtensionLaunchConfig | null> {
  const values = await storage.get([
    BRIDGE_URL_KEY,
    LAUNCH_TOKEN_KEY,
  ]);

  const bridgeUrl = values[BRIDGE_URL_KEY];
  const launchToken = values[LAUNCH_TOKEN_KEY];
  if (bridgeUrl === undefined && launchToken === undefined) {
    return null;
  }
  return validateExtensionLaunchConfig({
    bridge_url: bridgeUrl,
    launch_token: launchToken,
  });
}

export async function saveExtensionLaunchConfig(
  storage: ChromeStorageArea,
  config: ExtensionLaunchConfig,
): Promise<void> {
  const validated = validateExtensionLaunchConfig(config);
  await storage.set({
    [BRIDGE_URL_KEY]: validated.bridge_url,
    [LAUNCH_TOKEN_KEY]: validated.launch_token,
  });
}

export function validateExtensionLaunchConfig(
  config: {
    bridge_url: unknown;
    launch_token: unknown;
  },
): ExtensionLaunchConfig {
  if (
    typeof config.bridge_url !== "string" ||
    !config.bridge_url.trim() ||
    typeof config.launch_token !== "string" ||
    !config.launch_token.trim()
  ) {
    throw new Error("browser bridge launch configuration is incomplete");
  }

  const parsed = new URL(config.bridge_url);
  if (parsed.protocol !== "ws:") {
    throw new Error("browser bridge URL must use ws:// loopback");
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error("browser bridge URL must target loopback");
  }

  return {
    bridge_url: config.bridge_url,
    launch_token: config.launch_token,
  };
}

function toExtensionTab(tab: ChromeTabLike): ExtensionTab | null {
  if (
    typeof tab.id !== "number" ||
    typeof tab.windowId !== "number"
  ) {
    return null;
  }

  return {
    id: tab.id,
    window_id: tab.windowId,
    url: typeof tab.url === "string" ? tab.url : "about:blank",
    active: tab.active === true,
  };
}

function isPersistedPageRecord(
  value: unknown,
): value is ExtensionPageRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.page_id === "string" &&
    typeof record.tab_id === "number" &&
    typeof record.window_id === "number" &&
    typeof record.url === "string" &&
    typeof record.active === "boolean" &&
    (record.ownership === "tetherplane" ||
      record.ownership === "shared-observe" ||
      record.ownership === "shared-authorized")
  );
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}
