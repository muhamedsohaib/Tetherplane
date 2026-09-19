import { createHash, randomBytes } from "node:crypto";

import type {
  BrowserMode,
  BrowserOwnership,
  BrowserOwnershipRegistry,
  SemanticReference,
} from "./index.ts";
import {
  SemanticSnapshotEngine,
  type BackendSemanticNode,
} from "./semantic.ts";
import type { BrowserObservedState } from "./action.ts";

export type RawBrowserDownload = {
  backend_id: string;
  page_id: string;
  filename: string;
  local_path: string | null;
  state: "in_progress" | "complete" | "interrupted";
  bytes_received: number;
  total_bytes: number | null;
};

export type BrowserDownload = Omit<
  RawBrowserDownload,
  "backend_id"
> & {
  handle: string;
};

export type RawBrowserDiagnosticEvent = {
  kind: "console" | "network";
  level: string;
  message: string;
  url?: string;
  request_headers?: Record<string, string>;
  response_status?: number;
  timestamp_ms?: number;
};

export type BrowserDiagnosticEvent = RawBrowserDiagnosticEvent;

export type BrowserOperationalBackend = {
  observe(pageId: string): Promise<BrowserObservedState>;
  uploadFile(
    pageId: string,
    backendId: string,
    filePath: string,
  ): Promise<void>;
  downloads(pageId?: string): Promise<RawBrowserDownload[]>;
  diagnostics(
    pageId: string,
    limit: number,
  ): Promise<RawBrowserDiagnosticEvent[]>;
};

export type BrowserCheckpoint = {
  checkpoint_id: string;
  page_id: string;
  url: string;
  ownership: BrowserOwnership;
  semantic_revision: number;
  resource_revision: string | number | null;
  form_state: Array<{
    role: string;
    accessible_name: string;
    value: string;
  }>;
  pending_downloads: BrowserDownload[];
  created_at_unix_ms: number;
};

export class BrowserOperationalEngine {
  readonly #backend: BrowserOperationalBackend;
  readonly #ownership: BrowserOwnershipRegistry;
  readonly #semantics: SemanticSnapshotEngine;

  constructor(options: {
    backend: BrowserOperationalBackend;
    ownership: BrowserOwnershipRegistry;
    semantics?: SemanticSnapshotEngine;
  }) {
    this.#backend = options.backend;
    this.#ownership = options.ownership;
    this.#semantics =
      options.semantics ?? new SemanticSnapshotEngine();
  }

  async upload(request: {
    page_id: string;
    mode: BrowserMode;
    target: SemanticReference;
    file_path: string;
  }): Promise<{
    uploaded: true;
    page_id: string;
  }> {
    if (!request.file_path.trim()) {
      throw new TypeError("file_path must be non-empty");
    }

    this.#ownership.authorize({
      page_id: request.page_id,
      operation: "upload",
      mode: request.mode,
    });

    const observed = await this.#backend.observe(request.page_id);
    const target = this.#semantics.reacquire(
      request.target,
      observed.nodes,
    );
    await this.#backend.uploadFile(
      request.page_id,
      target.backend_id,
      request.file_path,
    );

    return {
      uploaded: true,
      page_id: request.page_id,
    };
  }

  async downloads(request: {
    page_id?: string;
  } = {}): Promise<{
    downloads: BrowserDownload[];
  }> {
    if (request.page_id) {
      this.#ownership.authorize({
        page_id: request.page_id,
        operation: "downloads",
        mode: "background_only",
      });
    }

    const raw = await this.#backend.downloads(request.page_id);
    return {
      downloads: raw.map(toDownload),
    };
  }

  async diagnostics(request: {
    page_id: string;
    limit?: number;
  }): Promise<{
    events: BrowserDiagnosticEvent[];
    truncated: boolean;
  }> {
    this.#ownership.authorize({
      page_id: request.page_id,
      operation: "diagnostics",
      mode: "background_only",
    });

    const limit = normalizeLimit(request.limit);
    const raw = await this.#backend.diagnostics(
      request.page_id,
      limit + 1,
    );
    const selected = raw.slice(0, limit).map(redactDiagnostic);

    return {
      events: selected,
      truncated: raw.length > selected.length,
    };
  }

  async checkpoint(request: {
    page_id: string;
    mode: BrowserMode;
  }): Promise<BrowserCheckpoint> {
    const page = this.#ownership.authorize({
      page_id: request.page_id,
      operation: "checkpoint",
      mode: request.mode,
    });
    const observed = await this.#backend.observe(request.page_id);
    const rawDownloads = await this.#backend.downloads(
      request.page_id,
    );

    return {
      checkpoint_id: `checkpoint_${randomBytes(8).toString("hex")}`,
      page_id: request.page_id,
      url: observed.url,
      ownership: page.ownership,
      semantic_revision: observed.semantic_revision,
      resource_revision: observed.resource_revision,
      form_state: safeFormState(observed.nodes),
      pending_downloads: rawDownloads
        .filter((download) => download.state === "in_progress")
        .map(toDownload),
      created_at_unix_ms: Date.now(),
    };
  }
}

function toDownload(raw: RawBrowserDownload): BrowserDownload {
  return {
    handle: stableDownloadHandle(raw.backend_id),
    page_id: raw.page_id,
    filename: raw.filename,
    local_path: raw.local_path,
    state: raw.state,
    bytes_received: raw.bytes_received,
    total_bytes: raw.total_bytes,
  };
}

function stableDownloadHandle(backendId: string): string {
  return `download_${createHash("sha256")
    .update(backendId)
    .digest("hex")
    .slice(0, 16)}`;
}

function safeFormState(
  nodes: BackendSemanticNode[],
): BrowserCheckpoint["form_state"] {
  return nodes
    .filter(
      (node) =>
        !node.hidden &&
        !node.sensitive &&
        node.value !== undefined &&
        isFormRole(node.role),
    )
    .slice(0, 200)
    .map((node) => ({
      role: node.role,
      accessible_name: node.accessible_name,
      value: node.value!,
    }));
}

function isFormRole(role: string): boolean {
  return (
    role === "textbox" ||
    role === "combobox" ||
    role === "checkbox" ||
    role === "radio" ||
    role === "spinbutton" ||
    role === "slider"
  );
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
]);

function redactDiagnostic(
  event: RawBrowserDiagnosticEvent,
): BrowserDiagnosticEvent {
  const headers = event.request_headers
    ? Object.fromEntries(
        Object.entries(event.request_headers)
          .filter(
            ([name]) =>
              !SENSITIVE_HEADER_NAMES.has(name.toLowerCase()),
          )
          .map(([name, value]) => [
            name,
            redactString(value),
          ]),
      )
    : undefined;

  return {
    kind: event.kind,
    level: event.level,
    message: redactString(event.message),
    ...(event.url
      ? { url: redactUrl(event.url) }
      : {}),
    ...(headers && Object.keys(headers).length > 0
      ? { request_headers: headers }
      : {}),
    ...(event.response_status !== undefined
      ? { response_status: event.response_status }
      : {}),
    ...(event.timestamp_ms !== undefined
      ? { timestamp_ms: event.timestamp_ms }
      : {}),
  };
}

function redactString(value: string): string {
  return value
    .replace(
      /authorization\s*:\s*bearer\s+[^\s,;]+/gi,
      "[REDACTED]",
    )
    .replace(
      /cookie\s*:\s*[^\r\n]+/gi,
      "[REDACTED]",
    )
    .replace(
      /(bearer\s+)[A-Za-z0-9._~+\/-]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:access|refresh|api|auth)[_-]?token\s*[=:]\s*)[^\s,;&]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(session\s*=\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (
        /token|secret|password|authorization|cookie|session|key/i.test(
          key,
        )
      ) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return parsed.toString();
  } catch {
    return redactString(value);
  }
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return 100;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError("limit must be a positive integer");
  }
  return Math.min(value, 500);
}
