import { randomUUID } from "node:crypto";

import type {
  BrowserBridgeBackend,
  BrowserObservedState,
  ResolvedBrowserAction,
} from "./action.ts";
import type {
  RawBrowserDiagnosticEvent,
  RawBrowserDownload,
} from "./operations.ts";

export type ExtensionCommandTransport = {
  send(message: Record<string, unknown>): void;
  nextMessage(): Promise<Record<string, unknown>>;
};

export type ExtensionPageInfo = {
  page_id: string;
  tab_id: number;
  active: boolean;
  ownership:
    | "human"
    | "tetherplane"
    | "shared-observe"
    | "shared-authorized";
  url: string;
  [key: string]: unknown;
};

export class ExtensionBackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExtensionBackendError";
    this.code = code;
  }
}

type PendingCommand = {
  resolve(value: unknown): void;
  reject(error: ExtensionBackendError): void;
};

export class ExtensionBrowserBackend
  implements BrowserBridgeBackend
{
  readonly #transport: ExtensionCommandTransport;
  readonly #pollIntervalMs: number;
  readonly #pending = new Map<string, PendingCommand>();
  #pumpRunning = false;

  constructor(options: {
    transport: ExtensionCommandTransport;
    pollIntervalMs?: number;
  }) {
    this.#transport = options.transport;
    this.#pollIntervalMs = normalizePollInterval(
      options.pollIntervalMs,
    );
  }

  async pages(): Promise<ExtensionPageInfo[]> {
    const data = await this.#call("pages", {});
    if (!isRecord(data) || !Array.isArray(data.pages)) {
      throw new ExtensionBackendError(
        "provider_failure",
        "extension pages response is invalid",
      );
    }
    return data.pages
      .filter(isExtensionPageInfo)
      .map((page) => structuredClone(page));
  }

  async createTab(url: string): Promise<ExtensionPageInfo> {
    const data = await this.#call("create_tab", { url });
    if (!isExtensionPageInfo(data)) {
      throw new ExtensionBackendError(
        "provider_failure",
        "extension create_tab response is invalid",
      );
    }
    return structuredClone(data);
  }

  async navigate(
    pageId: string,
    url: string,
  ): Promise<ExtensionPageInfo> {
    const data = await this.#call("navigate", {
      page_id: pageId,
      url,
    });
    if (!isExtensionPageInfo(data)) {
      throw new ExtensionBackendError(
        "provider_failure",
        "extension navigate response is invalid",
      );
    }
    return structuredClone(data);
  }

  async close(pageId: string): Promise<void> {
    await this.#call("close", { page_id: pageId });
  }

  async attach(
    tabId: number,
    operations: string[],
  ): Promise<ExtensionPageInfo> {
    const data = await this.#call("attach", {
      tab_id: tabId,
      operations,
    });
    if (!isExtensionPageInfo(data)) {
      throw new ExtensionBackendError(
        "provider_failure",
        "extension attach response is invalid",
      );
    }
    return structuredClone(data);
  }

  async detach(tabId: number): Promise<ExtensionPageInfo> {
    const data = await this.#call("detach", {
      tab_id: tabId,
    });
    if (!isExtensionPageInfo(data)) {
      throw new ExtensionBackendError(
        "provider_failure",
        "extension detach response is invalid",
      );
    }
    return structuredClone(data);
  }

  async observe(pageId: string): Promise<BrowserObservedState> {
    const data = await this.#call("observe", {
      page_id: pageId,
    });
    return parseObservedState(data);
  }

  async perform(
    pageId: string,
    action: ResolvedBrowserAction,
  ): Promise<void> {
    await this.#call("perform", {
      page_id: pageId,
      action,
    });
  }

  async uploadFile(
    pageId: string,
    backendId: string,
    filePath: string,
  ): Promise<void> {
    await this.#call("upload", {
      page_id: pageId,
      backend_id: backendId,
      file_path: filePath,
    });
  }

  async downloads(
    pageId?: string,
  ): Promise<RawBrowserDownload[]> {
    const data = await this.#call("downloads", {
      ...(pageId ? { page_id: pageId } : {}),
    });
    if (!isRecord(data) || !Array.isArray(data.downloads)) {
      throw new ExtensionBackendError(
        "provider_failure",
        "extension downloads response is invalid",
      );
    }
    return data.downloads
      .map(parseDownload)
      .filter(
        (item): item is RawBrowserDownload => item !== null,
      );
  }

  async diagnostics(
    pageId: string,
    limit: number,
  ): Promise<RawBrowserDiagnosticEvent[]> {
    const data = await this.#call("diagnostics", {
      page_id: pageId,
      limit,
    });
    if (!isRecord(data) || !Array.isArray(data.events)) {
      throw new ExtensionBackendError(
        "provider_failure",
        "extension diagnostics response is invalid",
      );
    }
    return data.events
      .map(parseDiagnostic)
      .filter(
        (item): item is RawBrowserDiagnosticEvent =>
          item !== null,
      );
  }

  async waitForSettled(
    pageId: string,
    afterRevision: number,
    timeoutMs: number,
  ): Promise<BrowserObservedState> {
    const timeout = normalizeTimeout(timeoutMs);
    const deadline = Date.now() + timeout;
    let current = await this.observe(pageId);

    while (
      current.semantic_revision === afterRevision &&
      Date.now() < deadline
    ) {
      await sleep(
        Math.min(
          this.#pollIntervalMs,
          Math.max(0, deadline - Date.now()),
        ),
      );
      current = await this.observe(pageId);
    }

    return current;
  }

  #call(
    operation: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      try {
        this.#transport.send({
          type: "command",
          request_id: requestId,
          operation,
          args,
        });
        this.#ensurePump();
      } catch (error) {
        this.#pending.delete(requestId);
        reject(
          normalizeTransportError(
            error,
            "extension command could not be sent",
          ),
        );
      }
    });
  }

  #ensurePump(): void {
    if (this.#pumpRunning) {
      return;
    }
    this.#pumpRunning = true;
    void this.#pump();
  }

  async #pump(): Promise<void> {
    try {
      while (this.#pending.size > 0) {
        const message = await this.#transport.nextMessage();
        if (
          message.type !== "result" ||
          typeof message.request_id !== "string"
        ) {
          continue;
        }

        const pending = this.#pending.get(message.request_id);
        if (!pending) {
          continue;
        }
        this.#pending.delete(message.request_id);

        if (message.status === "success") {
          pending.resolve(message.data);
          continue;
        }

        const error = isRecord(message.error)
          ? message.error
          : {};
        pending.reject(
          new ExtensionBackendError(
            typeof error.code === "string"
              ? error.code
              : "provider_failure",
            typeof error.message === "string"
              ? error.message
              : "extension command failed",
          ),
        );
      }
    } catch (error) {
      const normalized = normalizeTransportError(
        error,
        "extension command channel disconnected",
      );
      for (const pending of this.#pending.values()) {
        pending.reject(normalized);
      }
      this.#pending.clear();
    } finally {
      this.#pumpRunning = false;
    }
  }
}

function parseObservedState(value: unknown): BrowserObservedState {
  if (!isRecord(value)) {
    throw new ExtensionBackendError(
      "provider_failure",
      "extension observe response is invalid",
    );
  }

  if (
    typeof value.page_id !== "string" ||
    typeof value.url !== "string" ||
    typeof value.semantic_revision !== "number" ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.validation_messages) ||
    !Array.isArray(value.toasts)
  ) {
    throw new ExtensionBackendError(
      "provider_failure",
      "extension observe response is malformed",
    );
  }

  return {
    page_id: value.page_id,
    url: value.url,
    semantic_revision: value.semantic_revision,
    resource_revision:
      typeof value.resource_revision === "string" ||
      typeof value.resource_revision === "number"
        ? value.resource_revision
        : null,
    nodes: structuredClone(
      value.nodes,
    ) as BrowserObservedState["nodes"],
    validation_messages: value.validation_messages.filter(
      (item): item is string => typeof item === "string",
    ),
    toasts: value.toasts.filter(
      (item): item is string => typeof item === "string",
    ),
  };
}

function isExtensionPageInfo(
  value: unknown,
): value is ExtensionPageInfo {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.page_id === "string" &&
    typeof value.tab_id === "number" &&
    typeof value.active === "boolean" &&
    typeof value.url === "string" &&
    (value.ownership === "human" ||
      value.ownership === "tetherplane" ||
      value.ownership === "shared-observe" ||
      value.ownership === "shared-authorized")
  );
}

function parseDownload(
  value: unknown,
): RawBrowserDownload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.backend_id !== "string" ||
    typeof value.page_id !== "string" ||
    typeof value.filename !== "string" ||
    !(
      typeof value.local_path === "string" ||
      value.local_path === null
    ) ||
    !(
      value.state === "in_progress" ||
      value.state === "complete" ||
      value.state === "interrupted"
    ) ||
    typeof value.bytes_received !== "number" ||
    !(
      typeof value.total_bytes === "number" ||
      value.total_bytes === null
    )
  ) {
    return null;
  }
  return {
    backend_id: value.backend_id,
    page_id: value.page_id,
    filename: value.filename,
    local_path: value.local_path,
    state: value.state,
    bytes_received: value.bytes_received,
    total_bytes: value.total_bytes,
  };
}

function parseDiagnostic(
  value: unknown,
): RawBrowserDiagnosticEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !(value.kind === "console" || value.kind === "network") ||
    typeof value.level !== "string" ||
    typeof value.message !== "string"
  ) {
    return null;
  }

  const headers =
    isRecord(value.request_headers)
      ? Object.fromEntries(
          Object.entries(value.request_headers).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string",
          ),
        )
      : undefined;

  return {
    kind: value.kind,
    level: value.level,
    message: value.message,
    ...(typeof value.url === "string"
      ? { url: value.url }
      : {}),
    ...(headers && Object.keys(headers).length > 0
      ? { request_headers: headers }
      : {}),
    ...(typeof value.response_status === "number"
      ? { response_status: value.response_status }
      : {}),
    ...(typeof value.timestamp_ms === "number"
      ? { timestamp_ms: value.timestamp_ms }
      : {}),
  };
}

function normalizeTransportError(
  error: unknown,
  fallback: string,
): ExtensionBackendError {
  if (error instanceof ExtensionBackendError) {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return new ExtensionBackendError(
      (error as { code: string }).code,
      error instanceof Error ? error.message : fallback,
    );
  }
  return new ExtensionBackendError(
    "provider_failure",
    error instanceof Error ? error.message : fallback,
  );
}

function normalizePollInterval(value: number | undefined): number {
  if (value === undefined) {
    return 25;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("pollIntervalMs must be positive");
  }
  return Math.min(Math.floor(value), 1_000);
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeoutMs must be positive");
  }
  return Math.min(Math.floor(value), 60_000);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}
