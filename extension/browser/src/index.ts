import {
  BrowserOwnershipRegistry,
  type BrowserOperation,
  type BrowserOwnership,
} from "@tetherplane/browser-bridge";

export type ExtensionTab = {
  id: number;
  window_id: number;
  url: string;
  active: boolean;
};

export type ExtensionTabsAdapter = {
  list(): Promise<ExtensionTab[]>;
  get(tabId: number): Promise<ExtensionTab | null>;
  create(properties: {
    url: string;
    active: boolean;
  }): Promise<ExtensionTab>;
  update(
    tabId: number,
    properties: {
      url?: string;
      active?: boolean;
    },
  ): Promise<ExtensionTab>;
  remove(tabId: number): Promise<void>;
};

export type ExtensionPageRecord = {
  page_id: string;
  tab_id: number;
  window_id: number;
  url: string;
  active: boolean;
  ownership: BrowserOwnership;
  grant?: {
    operations: BrowserOperation[];
  };
};

export type ExtensionOwnershipStore = {
  load(): Promise<ExtensionPageRecord[]>;
  save(records: ExtensionPageRecord[]): Promise<void>;
};

export class ExtensionTabController {
  readonly #tabs: ExtensionTabsAdapter;
  readonly #store: ExtensionOwnershipStore;
  readonly #ownership = new BrowserOwnershipRegistry();
  readonly #pages = new Map<string, ExtensionPageRecord>();

  constructor(options: {
    tabs: ExtensionTabsAdapter;
    store: ExtensionOwnershipStore;
  }) {
    this.#tabs = options.tabs;
    this.#store = options.store;
  }

  async initialize(): Promise<void> {
    const persisted = new Map(
      (await this.#store.load()).map((record) => [
        record.page_id,
        record,
      ]),
    );

    this.#pages.clear();
    for (const tab of await this.#tabs.list()) {
      const pageId = pageIdForTab(tab.id);
      const saved = persisted.get(pageId);
      const record: ExtensionPageRecord = {
        page_id: pageId,
        tab_id: tab.id,
        window_id: tab.window_id,
        url: tab.url,
        active: tab.active,
        ownership: saved?.ownership ?? "human",
        ...(saved?.grant ? { grant: structuredClone(saved.grant) } : {}),
      };
      this.#record(record);
    }

    await this.#persist();
  }

  pages(): ExtensionPageRecord[] {
    return [...this.#pages.values()].map((page) =>
      structuredClone(page),
    );
  }

  async createOwnedTab(url: string): Promise<ExtensionPageRecord> {
    requireUrl(url);
    const tab = await this.#tabs.create({
      url,
      active: false,
    });
    const record: ExtensionPageRecord = {
      page_id: pageIdForTab(tab.id),
      tab_id: tab.id,
      window_id: tab.window_id,
      url: tab.url,
      active: false,
      ownership: "tetherplane",
    };
    this.#record(record);
    await this.#persist();
    return structuredClone(record);
  }

  async navigate(
    pageId: string,
    url: string,
  ): Promise<ExtensionPageRecord> {
    requireUrl(url);
    const page = this.#requirePage(pageId);
    this.#ownership.authorize({
      page_id: pageId,
      operation: "navigate",
      mode: "background_only",
    });

    const updated = await this.#tabs.update(page.tab_id, { url });
    const record: ExtensionPageRecord = {
      ...page,
      url: updated.url,
      active: updated.active,
      window_id: updated.window_id,
    };
    this.#record(record);
    await this.#persist();
    return structuredClone(record);
  }

  async close(pageId: string): Promise<void> {
    const page = this.#requirePage(pageId);
    this.#ownership.authorize({
      page_id: pageId,
      operation: "close",
      mode: "background_only",
    });

    await this.#tabs.remove(page.tab_id);
    this.#pages.delete(pageId);
    await this.#persist();
  }

  async attachHumanTab(
    tabId: number,
    grant: { operations: BrowserOperation[] },
  ): Promise<ExtensionPageRecord> {
    const tab = await this.#tabs.get(tabId);
    if (!tab) {
      throw new Error(`missing tab: ${tabId}`);
    }
    const record: ExtensionPageRecord = {
      page_id: pageIdForTab(tab.id),
      tab_id: tab.id,
      window_id: tab.window_id,
      url: tab.url,
      active: tab.active,
      ownership: "shared-authorized",
      grant: structuredClone(grant),
    };
    this.#record(record);
    await this.#persist();
    return structuredClone(record);
  }

  async detachHumanTab(tabId: number): Promise<ExtensionPageRecord> {
    const tab = await this.#tabs.get(tabId);
    if (!tab) {
      throw new Error(`missing tab: ${tabId}`);
    }
    const record: ExtensionPageRecord = {
      page_id: pageIdForTab(tab.id),
      tab_id: tab.id,
      window_id: tab.window_id,
      url: tab.url,
      active: tab.active,
      ownership: "human",
    };
    this.#record(record);
    await this.#persist();
    return structuredClone(record);
  }

  #record(record: ExtensionPageRecord): void {
    this.#pages.set(record.page_id, structuredClone(record));
    this.#ownership.register({
      page_id: record.page_id,
      ownership: record.ownership,
      active: record.active,
      ...(record.grant ? { grant: structuredClone(record.grant) } : {}),
    });
  }

  #requirePage(pageId: string): ExtensionPageRecord {
    const page = this.#pages.get(pageId);
    if (!page) {
      throw new Error(`unknown browser page: ${pageId}`);
    }
    return structuredClone(page);
  }

  async #persist(): Promise<void> {
    await this.#store.save(this.pages());
  }
}

function pageIdForTab(tabId: number): string {
  return `tab:${tabId}`;
}

function requireUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("browser URL must be absolute");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("browser URL must use http or https");
  }
}
