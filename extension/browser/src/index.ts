import {
  BrowserOwnershipRegistry,
  BrowserPolicyError,
  type BrowserOperation,
  type BrowserOwnership,
} from "@tetherplane/browser-bridge/policy";

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
    expires_at_ms: number;
    // Captured locally from chrome.tabs.get at approval time, never from RPC.
    origin?: string;
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
  // Owner approval is deliberately ephemeral; an extension restart fails closed.
  readonly #approvedOwnedOrigins = new Map<string, {
    operations: BrowserOperation[];
    expires_at_ms: number;
  }>();
  readonly #now: () => number;

  constructor(options: {
    tabs: ExtensionTabsAdapter;
    store: ExtensionOwnershipStore;
    now?: () => number;
  }) {
    this.#tabs = options.tabs;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
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
      const restored =
        saved && !this.#isExpired(saved) &&
          (saved.ownership === "tetherplane"
            ? Boolean(saved.grant?.origin &&
                this.#approvedOwnedOrigins.get(saved.grant.origin)?.expires_at_ms! > this.#now() &&
                saved.grant.origin === approvedOrigin(tab.url))
            : saved.grant?.origin !== undefined &&
              saved.grant.origin === approvedOrigin(tab.url))
          ? saved
          : undefined;
      const record: ExtensionPageRecord = {
        page_id: pageId,
        tab_id: tab.id,
        window_id: tab.window_id,
        url: tab.url,
        active: tab.active,
        ownership: restored?.ownership ?? "human",
        ...(restored?.grant
          ? { grant: structuredClone(restored.grant) }
          : {}),
      };
      this.#record(record);
    }

    await this.#persist();
  }

  pages(): ExtensionPageRecord[] {
    return [...this.#pages.keys()].map((pageId) =>
      this.#requirePage(pageId),
    );
  }

  async createOwnedTab(url: string): Promise<ExtensionPageRecord> {
    requireUrl(url);
    const origin = approvedOrigin(url);
    const grant = origin ? this.#approvedOwnedOrigins.get(origin) : undefined;
    if (!grant || grant.expires_at_ms <= this.#now()) {
      throw new BrowserPolicyError(
        "permission_denied",
        "an owner-approved website grant is required before opening an AI tab",
      );
    }
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
      grant: { origin: origin!, operations: [...grant.operations],
        expires_at_ms: grant.expires_at_ms },
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
    const page = await this.authorizeLivePage(pageId, "navigate");
    if (approvedOrigin(url) !== page.grant?.origin) {
      throw new BrowserPolicyError(
        "permission_denied",
        "navigation outside the owner-approved website origin is denied",
      );
    }
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
    grant: {
      operations: BrowserOperation[];
      ttl_ms: number;
    },
  ): Promise<ExtensionPageRecord> {
    if (
      !Number.isSafeInteger(grant.ttl_ms) ||
      grant.ttl_ms <= 0 ||
      grant.ttl_ms > 3_600_000
    ) {
      throw new BrowserPolicyError(
        "invalid_arguments",
        "attachment ttl_ms must be between 1 and 3600000",
      );
    }

    const tab = await this.#tabs.get(tabId);
    if (!tab) {
      throw new Error(`missing tab: ${tabId}`);
    }
    const origin = approvedOrigin(tab.url);
    if (!origin) {
      throw new BrowserPolicyError(
        "permission_denied",
        "only http/https website tabs can be shared",
      );
    }
    const record: ExtensionPageRecord = {
      page_id: pageIdForTab(tab.id),
      tab_id: tab.id,
      window_id: tab.window_id,
      url: tab.url,
      active: tab.active,
      ownership: "shared-authorized",
      grant: {
        operations: [...grant.operations],
        expires_at_ms: this.#now() + grant.ttl_ms,
        origin,
      },
    };
    this.#record(record);
    await this.#persist();
    return structuredClone(record);
  }

  async approveOwnedOriginFromTab(tabId: number, grant: {
    ttl_ms: number;
    operations: BrowserOperation[];
  }): Promise<{ origin: string; expires_at_ms: number }> {
    if (!Number.isSafeInteger(grant.ttl_ms) ||
        grant.ttl_ms <= 0 || grant.ttl_ms > 3_600_000) {
      throw new BrowserPolicyError("invalid_arguments", "invalid site-grant duration");
    }
    const tab = await this.#tabs.get(tabId);
    const origin = tab ? approvedOrigin(tab.url) : null;
    if (!origin) {
      throw new BrowserPolicyError("permission_denied", "approved tab must be an open website");
    }
    const expires_at_ms = this.#now() + grant.ttl_ms;
    this.#approvedOwnedOrigins.set(origin, {
      operations: [...grant.operations], expires_at_ms,
    });
    return { origin, expires_at_ms };
  }

  async revokeOwnedOriginFromTab(tabId: number): Promise<void> {
    const tab = await this.#tabs.get(tabId);
    const origin = tab ? approvedOrigin(tab.url) : null;
    if (!origin) {
      throw new BrowserPolicyError("permission_denied", "site origin unavailable for revocation");
    }
    this.#approvedOwnedOrigins.delete(origin);
    for (const page of this.#pages.values()) {
      if (page.ownership === "tetherplane" && page.grant?.origin === origin) {
        this.#record({ ...page, ownership: "human", grant: undefined });
      }
    }
    await this.#persist();
  }

  // Trust boundary shared by extension commands, independently of RPC state.
  // chrome.tabs.get is checked for every operation, not only at approval.
  async authorizeLivePage(
    pageId: string,
    operation: BrowserOperation,
  ): Promise<ExtensionPageRecord> {
    const page = this.#requirePage(pageId);
    if (page.ownership === "tetherplane") {
      const live = await this.#tabs.get(page.tab_id);
      const origin = page.grant?.origin;
      const currentGrant = origin ? this.#approvedOwnedOrigins.get(origin) : undefined;
      if (!live || !origin || approvedOrigin(live.url) !== origin ||
          !currentGrant || currentGrant.expires_at_ms <= this.#now()) {
        this.#record({ ...page, ownership: "human", grant: undefined,
          ...(live ? { url: live.url, active: live.active, window_id: live.window_id } : {}) });
        await this.#persist();
        throw new BrowserPolicyError("permission_denied",
          "AI-owned tab left the approved website or the site grant was revoked");
      }
      const observeOnly = operation === "snapshot" || operation === "wait" ||
        operation === "checkpoint";
      if (!observeOnly && !currentGrant.operations.includes(operation)) {
        throw new BrowserPolicyError("permission_denied",
          "operation was not approved for this AI-owned site");
      }
      return structuredClone({ ...page, url: live.url, active: live.active,
        window_id: live.window_id });
    }

    if (page.ownership !== "shared-authorized" &&
        page.ownership !== "shared-observe") {
      throw new BrowserPolicyError(
        "permission_denied",
        "a human tab must be explicitly shared before access",
      );
    }

    const live = await this.#tabs.get(page.tab_id);
    const origin = live ? approvedOrigin(live.url) : null;
    if (!live || !page.grant?.origin ||
        page.grant.expires_at_ms <= this.#now() ||
        origin !== page.grant.origin) {
      const revoked: ExtensionPageRecord = {
        page_id: page.page_id,
        tab_id: page.tab_id,
        window_id: live?.window_id ?? page.window_id,
        url: live?.url ?? page.url,
        active: live?.active ?? page.active,
        ownership: "human",
      };
      this.#record(revoked);
      await this.#persist();
      throw new BrowserPolicyError(
        "permission_denied",
        "the sharing grant expired or the browser left its approved origin",
      );
    }

    const observeOnly = operation === "snapshot" ||
      operation === "wait" || operation === "checkpoint";
    if ((!observeOnly && !page.grant.operations.includes(operation)) ||
        (page.ownership === "shared-observe" && !observeOnly)) {
      throw new BrowserPolicyError(
        "permission_denied",
        "the owner has not approved this operation",
      );
    }

    return structuredClone({
      ...page, url: live.url, active: live.active, window_id: live.window_id,
    });
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

    if (this.#isExpired(page)) {
      const expired: ExtensionPageRecord = {
        page_id: page.page_id,
        tab_id: page.tab_id,
        window_id: page.window_id,
        url: page.url,
        active: page.active,
        ownership: "human",
      };
      this.#record(expired);
      return structuredClone(expired);
    }

    return structuredClone(page);
  }

  #isExpired(page: ExtensionPageRecord): boolean {
    return (
      (page.ownership === "shared-authorized" ||
        page.ownership === "tetherplane") &&
      (!page.grant ||
        (page.ownership === "tetherplane" &&
         (!this.#approvedOwnedOrigins.has(page.grant.origin ?? "") ||
          this.#approvedOwnedOrigins.get(page.grant.origin ?? "")!.expires_at_ms <= this.#now())) ||
        !page.grant.origin ||
        !Number.isFinite(page.grant.expires_at_ms) ||
        page.grant.expires_at_ms <= this.#now())
    );
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

function approvedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
