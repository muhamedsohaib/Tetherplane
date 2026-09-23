import {
  BrowserPolicyError,
  type BrowserOperation,
} from "@tetherplane/browser-bridge/policy";

import type {
  RawBrowserDiagnosticEvent,
  RawBrowserDownload,
} from "@tetherplane/browser-bridge";

export type ExtensionRuntimeSession = {
  send(message: Record<string, unknown>): void;
  nextMessage(): Promise<Record<string, unknown>>;
};

export type ExtensionCommandController = {
  pages(): unknown[];
  createOwnedTab(url: string): Promise<unknown>;
  navigate(pageId: string, url: string): Promise<unknown>;
  close(pageId: string): Promise<void>;
  attachHumanTab(
    tabId: number,
    grant: { operations: BrowserOperation[] },
  ): Promise<unknown>;
  detachHumanTab(tabId: number): Promise<unknown>;
};

export type ExtensionPageAgent = {
  observe(pageId: string): Promise<unknown>;
  perform(
    pageId: string,
    action: Record<string, unknown>,
  ): Promise<void>;
};

export type ExtensionOperationalAgent = {
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

export class ExtensionCommandRuntime {
  readonly #session: ExtensionRuntimeSession;
  readonly #controller: ExtensionCommandController;
  readonly #pageAgent: ExtensionPageAgent;
  readonly #operationalAgent: ExtensionOperationalAgent | null;

  constructor(options: {
    session: ExtensionRuntimeSession;
    controller: ExtensionCommandController;
    pageAgent: ExtensionPageAgent;
    operationalAgent?: ExtensionOperationalAgent;
  }) {
    this.#session = options.session;
    this.#controller = options.controller;
    this.#pageAgent = options.pageAgent;
    this.#operationalAgent = options.operationalAgent ?? null;
  }

  async run(): Promise<void> {
    for (;;) {
      let message: Record<string, unknown>;
      try {
        message = await this.#session.nextMessage();
      } catch {
        return;
      }
      await this.handleMessage(message);
    }
  }

  async handleMessage(
    message: Record<string, unknown>,
  ): Promise<void> {
    if (message.type !== "command") {
      return;
    }

    const requestId =
      typeof message.request_id === "string"
        ? message.request_id
        : null;
    const operation =
      typeof message.operation === "string"
        ? message.operation
        : null;
    const args = isRecord(message.args) ? message.args : {};

    if (!requestId || !operation) {
      if (requestId) {
        this.#sendError(
          requestId,
          "invalid_arguments",
          "extension command requires request_id and operation",
        );
      }
      return;
    }

    try {
      const data = await this.#execute(operation, args);
      this.#session.send({
        type: "result",
        request_id: requestId,
        status: "success",
        data,
      });
    } catch (error) {
      const normalized = normalizeError(error);
      this.#sendError(
        requestId,
        normalized.code,
        normalized.message,
      );
    }
  }

  async #execute(
    operation: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (operation) {
      case "pages":
        return {
          pages: this.#controller.pages(),
        };

      case "create_tab":
        return this.#controller.createOwnedTab(
          requiredString(args, "url"),
        );

      case "navigate":
        return this.#controller.navigate(
          requiredString(args, "page_id"),
          requiredString(args, "url"),
        );

      case "close":
        await this.#controller.close(
          requiredString(args, "page_id"),
        );
        return { closed: true };

      case "attach":
        return this.#controller.attachHumanTab(
          requiredInteger(args, "tab_id"),
          {
            operations: requiredOperations(args, "operations"),
          },
        );

      case "detach":
        return this.#controller.detachHumanTab(
          requiredInteger(args, "tab_id"),
        );

      case "observe":
        return this.#pageAgent.observe(
          requiredString(args, "page_id"),
        );

      case "perform": {
        const action = args.action;
        if (!isRecord(action)) {
          throw new RuntimeCommandError(
            "invalid_arguments",
            "perform requires object args.action",
          );
        }
        await this.#pageAgent.perform(
          requiredString(args, "page_id"),
          action,
        );
        return { performed: true };
      }

      case "upload": {
        const agent = this.#requireOperationalAgent("upload");
        await agent.uploadFile(
          requiredString(args, "page_id"),
          requiredString(args, "backend_id"),
          requiredString(args, "file_path"),
        );
        return { uploaded: true };
      }

      case "downloads": {
        const agent = this.#requireOperationalAgent("downloads");
        const pageId = optionalString(args, "page_id");
        return {
          downloads: await agent.downloads(pageId),
        };
      }

      case "diagnostics": {
        const agent = this.#requireOperationalAgent("diagnostics");
        return {
          events: await agent.diagnostics(
            requiredString(args, "page_id"),
            optionalPositiveInteger(args, "limit") ?? 100,
          ),
        };
      }

      default:
        throw new RuntimeCommandError(
          "capability_unavailable",
          `unsupported extension operation: ${operation}`,
        );
    }
  }

  #requireOperationalAgent(
    operation: string,
  ): ExtensionOperationalAgent {
    if (!this.#operationalAgent) {
      throw new RuntimeCommandError(
        "capability_unavailable",
        `extension operational backend is unavailable for ${operation}`,
      );
    }
    return this.#operationalAgent;
  }

  #sendError(
    requestId: string,
    code: string,
    message: string,
  ): void {
    this.#session.send({
      type: "result",
      request_id: requestId,
      status: "error",
      error: {
        code,
        message,
      },
    });
  }
}

class RuntimeCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeCommandError";
    this.code = code;
  }
}

const BROWSER_OPERATIONS = new Set<BrowserOperation>([
  "status",
  "pages",
  "snapshot",
  "navigate",
  "close",
  "act",
  "wait",
  "upload",
  "downloads",
  "diagnostics",
  "checkpoint",
]);

function requiredOperations(
  value: Record<string, unknown>,
  key: string,
): BrowserOperation[] {
  const raw = value[key];
  if (
    !Array.isArray(raw) ||
    !raw.every(
      (item): item is BrowserOperation =>
        typeof item === "string" &&
        BROWSER_OPERATIONS.has(item as BrowserOperation),
    )
  ) {
    throw new RuntimeCommandError(
      "invalid_arguments",
      `${key} must contain valid browser operations`,
    );
  }
  return [...raw];
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const raw = value[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new RuntimeCommandError(
      "invalid_arguments",
      `${key} must be a non-empty string`,
    );
  }
  return raw;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = value[key];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    throw new RuntimeCommandError(
      "invalid_arguments",
      `${key} must be a non-empty string when provided`,
    );
  }
  return raw;
}

function optionalPositiveInteger(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = value[key];
  if (raw === undefined) {
    return undefined;
  }
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw <= 0
  ) {
    throw new RuntimeCommandError(
      "invalid_arguments",
      `${key} must be a positive integer when provided`,
    );
  }
  return raw;
}

function requiredInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const raw = value[key];
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < 0
  ) {
    throw new RuntimeCommandError(
      "invalid_arguments",
      `${key} must be a non-negative integer`,
    );
  }
  return raw;
}

function normalizeError(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof BrowserPolicyError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return {
      code: (error as { code: string }).code,
      message:
        error instanceof Error
          ? error.message
          : "extension command failed",
    };
  }
  return {
    code: "provider_failure",
    message:
      error instanceof Error
        ? error.message
        : "extension command failed unexpectedly",
  };
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
