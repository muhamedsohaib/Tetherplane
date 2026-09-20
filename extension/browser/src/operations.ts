import type {
  BrowserOperation,
  RawBrowserDiagnosticEvent,
  RawBrowserDownload,
} from "@tetherplane/browser-bridge";

type OperationalPageRecord = {
  page_id: string;
  tab_id: number;
  url: string;
  ownership:
    | "human"
    | "tetherplane"
    | "shared-observe"
    | "shared-authorized";
  grant?: {
    operations: BrowserOperation[];
  };
};

export type ChromeDebuggerEventListener = (
  source: { tabId?: number },
  method: string,
  params: Record<string, unknown>,
) => void;

export type ChromeDebuggerApi = {
  attach(
    target: { tabId: number },
    requiredVersion: string,
  ): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  sendCommand(
    target: { tabId: number },
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  onEvent: {
    addListener(listener: ChromeDebuggerEventListener): void;
    removeListener(listener: ChromeDebuggerEventListener): void;
  };
};

export type ChromeDownloadItem = {
  id: number;
  url: string;
  referrer?: string;
  filename: string;
  state: string;
  bytesReceived: number;
  totalBytes: number;
};

export type ChromeDownloadsApi = {
  search(
    query?: Record<string, unknown>,
  ): Promise<ChromeDownloadItem[]>;
};

export type OperationalController = {
  pages(): OperationalPageRecord[];
};

export class ChromeOperationalError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChromeOperationalError";
    this.code = code;
  }
}

export class ChromeOperationalAgent {
  readonly #controller: OperationalController;
  readonly #debugger: ChromeDebuggerApi;
  readonly #downloads: ChromeDownloadsApi;
  readonly #maxDiagnosticEvents: number;
  readonly #attachedTabs = new Set<number>();
  readonly #diagnosticsEnabled = new Set<number>();
  readonly #diagnosticsByPage = new Map<
    string,
    RawBrowserDiagnosticEvent[]
  >();
  readonly #eventListener: ChromeDebuggerEventListener;

  constructor(options: {
    controller: OperationalController;
    debuggerApi: ChromeDebuggerApi;
    downloadsApi: ChromeDownloadsApi;
    maxDiagnosticEvents?: number;
  }) {
    this.#controller = options.controller;
    this.#debugger = options.debuggerApi;
    this.#downloads = options.downloadsApi;
    this.#maxDiagnosticEvents = normalizeMaxEvents(
      options.maxDiagnosticEvents,
    );
    this.#eventListener = (source, method, params) => {
      this.#handleDebuggerEvent(source, method, params);
    };
    this.#debugger.onEvent.addListener(this.#eventListener);
  }

  async uploadFile(
    pageId: string,
    backendId: string,
    filePath: string,
  ): Promise<void> {
    const page = this.#requireAuthorizedPage(pageId, "upload");
    if (!filePath.trim()) {
      throw new ChromeOperationalError(
        "invalid_arguments",
        "file_path must be non-empty",
      );
    }

    const parsed = parseBackendId(backendId);
    if (parsed.frameId !== 0) {
      throw new ChromeOperationalError(
        "capability_unavailable",
        "native extension upload currently supports top-frame file inputs only",
      );
    }

    await this.#ensureAttached(page.tab_id);
    const target = { tabId: page.tab_id };
    await this.#debugger.sendCommand(target, "DOM.enable");

    const documentResult = await this.#debugger.sendCommand(
      target,
      "DOM.getDocument",
      {
        depth: 0,
        pierce: true,
      },
    );
    const root = asRecord(documentResult.root);
    const rootNodeId = numericField(root, "nodeId");

    const queryResult = await this.#debugger.sendCommand(
      target,
      "DOM.querySelector",
      {
        nodeId: rootNodeId,
        selector: parsed.selector,
      },
    );
    const nodeId = numericField(queryResult, "nodeId");
    if (nodeId <= 0) {
      throw new ChromeOperationalError(
        "stale_reference",
        "file input no longer exists",
      );
    }

    await this.#debugger.sendCommand(
      target,
      "DOM.setFileInputFiles",
      {
        nodeId,
        files: [filePath],
      },
    );

    const resolved = await this.#debugger.sendCommand(
      target,
      "DOM.resolveNode",
      { nodeId },
    );
    const object = asRecord(resolved.object);
    const objectId = stringField(object, "objectId");
    if (!objectId) {
      throw new ChromeOperationalError(
        "provider_failure",
        "browser debugger could not resolve uploaded file input",
      );
    }

    await this.#debugger.sendCommand(
      target,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration:
          "function(){this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}",
        returnByValue: true,
      },
    );
  }

  async downloads(
    pageId?: string,
  ): Promise<RawBrowserDownload[]> {
    const page = pageId ? this.#requirePage(pageId) : null;
    const origin = page ? originOf(page.url) : null;
    const items = await this.#downloads.search({});

    return items
      .filter((item) => {
        if (!origin) {
          return true;
        }
        return (
          originOf(item.url) === origin ||
          originOf(item.referrer ?? "") === origin
        );
      })
      .map((item) => ({
        backend_id: `chrome:${item.id}`,
        page_id: page?.page_id ?? "browser",
        filename:
          portableBasename(item.filename) ||
          `download-${item.id}`,
        local_path: item.filename || null,
        state: normalizeDownloadState(item.state),
        bytes_received: Math.max(0, item.bytesReceived),
        total_bytes:
          item.totalBytes >= 0 ? item.totalBytes : null,
      }));
  }

  async diagnostics(
    pageId: string,
    limit: number,
  ): Promise<RawBrowserDiagnosticEvent[]> {
    const page = this.#requireAuthorizedPage(
      pageId,
      "diagnostics",
    );
    await this.#ensureDiagnostics(page);

    const normalizedLimit = Math.max(
      1,
      Math.min(Math.floor(limit), this.#maxDiagnosticEvents),
    );
    const events = this.#diagnosticsByPage.get(pageId) ?? [];
    return structuredClone(events.slice(-normalizedLimit));
  }

  async close(): Promise<void> {
    this.#debugger.onEvent.removeListener(this.#eventListener);
    for (const tabId of [...this.#attachedTabs]) {
      await this.#debugger
        .detach({ tabId })
        .catch(() => undefined);
    }
    this.#attachedTabs.clear();
    this.#diagnosticsEnabled.clear();
    this.#diagnosticsByPage.clear();
  }

  async #ensureAttached(tabId: number): Promise<void> {
    if (this.#attachedTabs.has(tabId)) {
      return;
    }
    try {
      await this.#debugger.attach({ tabId }, "1.3");
      this.#attachedTabs.add(tabId);
    } catch (error) {
      throw new ChromeOperationalError(
        "provider_failure",
        error instanceof Error
          ? error.message
          : "failed to attach browser debugger",
      );
    }
  }

  async #ensureDiagnostics(
    page: OperationalPageRecord,
  ): Promise<void> {
    if (this.#diagnosticsEnabled.has(page.tab_id)) {
      return;
    }

    await this.#ensureAttached(page.tab_id);
    const target = { tabId: page.tab_id };
    await this.#debugger.sendCommand(target, "Log.enable");
    await this.#debugger.sendCommand(target, "Network.enable");
    this.#diagnosticsEnabled.add(page.tab_id);
    this.#diagnosticsByPage.set(
      page.page_id,
      this.#diagnosticsByPage.get(page.page_id) ?? [],
    );
  }

  #handleDebuggerEvent(
    source: { tabId?: number },
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (typeof source.tabId !== "number") {
      return;
    }
    const page = this.#controller
      .pages()
      .find((candidate) => candidate.tab_id === source.tabId);
    if (
      !page ||
      !this.#diagnosticsEnabled.has(source.tabId)
    ) {
      return;
    }

    const event = diagnosticFromDebuggerEvent(method, params);
    if (!event) {
      return;
    }

    const events = this.#diagnosticsByPage.get(page.page_id) ?? [];
    events.push(event);
    if (events.length > this.#maxDiagnosticEvents) {
      events.splice(
        0,
        events.length - this.#maxDiagnosticEvents,
      );
    }
    this.#diagnosticsByPage.set(page.page_id, events);
  }

  #requirePage(pageId: string): OperationalPageRecord {
    const page = this.#controller
      .pages()
      .find((candidate) => candidate.page_id === pageId);
    if (!page) {
      throw new ChromeOperationalError(
        "invalid_arguments",
        `unknown browser page: ${pageId}`,
      );
    }
    return structuredClone(page);
  }

  #requireAuthorizedPage(
    pageId: string,
    operation: BrowserOperation,
  ): OperationalPageRecord {
    const page = this.#requirePage(pageId);
    if (page.ownership === "tetherplane") {
      return page;
    }
    if (
      page.ownership === "shared-authorized" &&
      page.grant?.operations.includes(operation)
    ) {
      return page;
    }
    throw new ChromeOperationalError(
      "permission_denied",
      `browser ${operation} requires a Tetherplane-owned or explicitly shared-authorized tab`,
    );
  }
}

function parseBackendId(value: string): {
  frameId: number;
  selector: string;
} {
  const match = /^frame:(\d+)\|css:(.+)$/.exec(value);
  if (!match) {
    throw new ChromeOperationalError(
      "stale_reference",
      "browser backend handle is invalid or stale",
    );
  }
  return {
    frameId: Number(match[1]),
    selector: match[2]!,
  };
}

function diagnosticFromDebuggerEvent(
  method: string,
  params: Record<string, unknown>,
): RawBrowserDiagnosticEvent | null {
  if (method === "Log.entryAdded") {
    const entry = asRecord(params.entry);
    return {
      kind: "console",
      level: stringField(entry, "level") ?? "info",
      message: stringField(entry, "text") ?? "",
      ...(stringField(entry, "url")
        ? { url: stringField(entry, "url")! }
        : {}),
      ...(numberField(entry, "timestamp") !== null
        ? {
            timestamp_ms: Math.floor(
              numberField(entry, "timestamp")! * 1_000,
            ),
          }
        : {}),
    };
  }

  if (method === "Network.requestWillBeSent") {
    const request = asRecord(params.request);
    const url = stringField(request, "url") ?? "";
    const headers = safeHeaders(asRecord(request.headers));
    return {
      kind: "network",
      level: "info",
      message: `request ${url}`,
      ...(url ? { url } : {}),
      ...(Object.keys(headers).length > 0
        ? { request_headers: headers }
        : {}),
      ...(numberField(params, "timestamp") !== null
        ? {
            timestamp_ms: Math.floor(
              numberField(params, "timestamp")! * 1_000,
            ),
          }
        : {}),
    };
  }

  if (method === "Network.responseReceived") {
    const response = asRecord(params.response);
    const url = stringField(response, "url") ?? "";
    const status = numberField(response, "status");
    return {
      kind: "network",
      level:
        status !== null && status >= 400 ? "error" : "info",
      message: `response ${status ?? "unknown"} ${url}`,
      ...(url ? { url } : {}),
      ...(status !== null ? { response_status: status } : {}),
      ...(numberField(params, "timestamp") !== null
        ? {
            timestamp_ms: Math.floor(
              numberField(params, "timestamp")! * 1_000,
            ),
          }
        : {}),
    };
  }

  return null;
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
]);

function safeHeaders(
  headers: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(
        ([name]) =>
          !SENSITIVE_HEADERS.has(name.toLowerCase()),
      )
      .filter((entry): entry is [string, string] =>
        typeof entry[1] === "string",
      ),
  );
}

function normalizeDownloadState(
  value: string,
): RawBrowserDownload["state"] {
  if (value === "complete") {
    return "complete";
  }
  if (value === "interrupted") {
    return "interrupted";
  }
  return "in_progress";
}

function normalizeMaxEvents(value: number | undefined): number {
  if (value === undefined) {
    return 200;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(
      "maxDiagnosticEvents must be a positive integer",
    );
  }
  return Math.min(value, 2_000);
}

function portableBasename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numericField(
  record: Record<string, unknown>,
  key: string,
): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new ChromeOperationalError(
      "provider_failure",
      `browser debugger response is missing ${key}`,
    );
  }
  return value;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | null {
  return typeof record[key] === "number"
    ? (record[key] as number)
    : null;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  return typeof record[key] === "string"
    ? (record[key] as string)
    : null;
}
