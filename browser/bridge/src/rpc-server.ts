import net from "node:net";

import {
  BrowserOwnershipRegistry,
  BrowserPolicyError,
  type BrowserMode,
  type BrowserOperation,
} from "./index.ts";
import { SemanticSnapshotEngine } from "./semantic.ts";
import {
  VerifiedActionEngine,
  type BrowserBridgeBackend,
} from "./action.ts";
import {
  BrowserOperationalEngine,
  type BrowserOperationalBackend,
} from "./operations.ts";

export type BrowserServicePage = {
  page_id: string;
  ownership: "human" | "tetherplane" | "shared-observe" | "shared-authorized";
  active: boolean;
  url: string;
  grant?: { operations: BrowserOperation[] };
  [key: string]: unknown;
};

export interface BrowserServiceBackend
  extends BrowserBridgeBackend,
    BrowserOperationalBackend {
  capabilities(): Record<string, unknown>;
  pages(): Promise<BrowserServicePage[]>;
  createTab(url: string): Promise<BrowserServicePage>;
  navigate(pageId: string, url: string): Promise<BrowserServicePage>;
  close(pageId: string): Promise<void>;
}

type RpcRequest = {
  type: "handshake" | "invoke";
  request_id: string;
  token?: string;
  capability?: string;
  arguments?: Record<string, unknown>;
  [key: string]: unknown;
};

type RpcVerification =
  | "not_applicable"
  | "verified"
  | "executed_unverified"
  | "failed";

type RpcResponse = {
  request_id: string;
  status: "success" | "error";
  data?: unknown;
  delta?: unknown;
  verification?: RpcVerification;
  error?: { code: string; message: string; details?: unknown };
};

const OPERATIONS = [
  "status",
  "pages",
  "create_tab",
  "snapshot",
  "navigate",
  "close",
  "act",
  "wait",
  "upload",
  "downloads",
  "diagnostics",
  "checkpoint",
] as const;

export class BrowserBridgeService {
  readonly #backend: BrowserServiceBackend;
  readonly #ownership: BrowserOwnershipRegistry;
  readonly #semantics: SemanticSnapshotEngine;
  readonly #actions: VerifiedActionEngine;
  readonly #operations: BrowserOperationalEngine;

  constructor(options: {
    backend: BrowserServiceBackend;
    ownership?: BrowserOwnershipRegistry;
    semantics?: SemanticSnapshotEngine;
  }) {
    this.#backend = options.backend;
    this.#ownership =
      options.ownership ?? new BrowserOwnershipRegistry();
    this.#semantics =
      options.semantics ?? new SemanticSnapshotEngine();
    this.#actions = new VerifiedActionEngine({
      backend: this.#backend,
      ownership: this.#ownership,
      semantics: this.#semantics,
    });
    this.#operations = new BrowserOperationalEngine({
      backend: this.#backend,
      ownership: this.#ownership,
      semantics: this.#semantics,
    });
  }

  operations(): string[] {
    return [...OPERATIONS];
  }

  async invoke(
    capability: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; verification: RpcVerification }> {
    const operation = capability.startsWith("browser.")
      ? capability.slice("browser.".length)
      : "";
    if (
      !OPERATIONS.includes(
        operation as (typeof OPERATIONS)[number],
      )
    ) {
      throw codedError(
        "capability_unavailable",
        "browser operation is unavailable: " +
          (operation || capability),
      );
    }

    if (operation === "status") {
      return {
        data: {
          available: true,
          mode: "background_only",
          capabilities: this.#backend.capabilities(),
        },
        verification: "not_applicable",
      };
    }

    if (operation === "pages") {
      return {
        data: { pages: await this.#syncPages() },
        verification: "not_applicable",
      };
    }

    if (operation === "create_tab") {
      const page = await this.#backend.createTab(
        requiredString(args, "url"),
      );
      this.#ownership.register({
        page_id: page.page_id,
        ownership: "tetherplane",
        active: false,
      });
      return {
        data: {
          ...page,
          ownership: "tetherplane",
          active: false,
        },
        verification: "verified",
      };
    }

    const pageId = optionalString(args, "page_id");
    if (pageId) {
      await this.#syncPage(pageId);
    }

    if (operation === "snapshot") {
      const id = requiredString(args, "page_id");
      this.#ownership.authorize({
        page_id: id,
        operation: "snapshot",
        mode: "background_only",
      });
      const observed = await this.#backend.observe(id);
      return {
        data: this.#semantics.snapshot(observed.nodes, {
          revision: observed.semantic_revision,
        }),
        verification: "not_applicable",
      };
    }

    if (operation === "navigate") {
      const id = requiredString(args, "page_id");
      this.#ownership.authorize({
        page_id: id,
        operation: "navigate",
        mode: browserMode(args),
      });
      return {
        data: await this.#backend.navigate(
          id,
          requiredString(args, "url"),
        ),
        verification: "verified",
      };
    }

    if (operation === "close") {
      const id = requiredString(args, "page_id");
      this.#ownership.authorize({
        page_id: id,
        operation: "close",
        mode: browserMode(args),
      });
      await this.#backend.close(id);
      return {
        data: { closed: true, page_id: id },
        verification: "verified",
      };
    }

    if (operation === "act") {
      const result = await this.#actions.execute({
        ...args,
        mode: browserMode(args),
      } as Parameters<
        VerifiedActionEngine["execute"]
      >[0]);
      return {
        data: result,
        verification:
          result.state === "verified" ? "verified" : "failed",
      };
    }

    if (operation === "wait") {
      const result = await this.#actions.wait(
        args as Parameters<VerifiedActionEngine["wait"]>[0],
      );
      return {
        data: result,
        verification:
          result.state === "verified" ? "verified" : "failed",
      };
    }

    if (operation === "upload") {
      return {
        data: await this.#operations.upload({
          ...args,
          mode: browserMode(args),
        } as Parameters<
          BrowserOperationalEngine["upload"]
        >[0]),
        verification: "verified",
      };
    }

    if (operation === "downloads") {
      return {
        data: await this.#operations.downloads(
          args as Parameters<
            BrowserOperationalEngine["downloads"]
          >[0],
        ),
        verification: "not_applicable",
      };
    }

    if (operation === "diagnostics") {
      return {
        data: await this.#operations.diagnostics(
          args as Parameters<
            BrowserOperationalEngine["diagnostics"]
          >[0],
        ),
        verification: "not_applicable",
      };
    }

    return {
      data: await this.#operations.checkpoint({
        ...args,
        mode: browserMode(args),
      } as Parameters<
        BrowserOperationalEngine["checkpoint"]
      >[0]),
      verification: "not_applicable",
    };
  }

  async #syncPages(): Promise<BrowserServicePage[]> {
    const pages = await this.#backend.pages();
    for (const page of pages) {
      this.#ownership.register({
        page_id: page.page_id,
        ownership: page.ownership,
        active: page.active,
        ...(page.grant
          ? { grant: structuredClone(page.grant) }
          : {}),
      });
    }
    return pages;
  }

  async #syncPage(pageId: string): Promise<void> {
    const pages = await this.#syncPages();
    if (!pages.some((page) => page.page_id === pageId)) {
      throw codedError(
        "invalid_arguments",
        "unknown browser page: " + pageId,
      );
    }
  }
}

export type BrowserRpcServer = {
  address: string;
  close(): Promise<void>;
};

export async function startBrowserRpcServer(options: {
  service: BrowserBridgeService;
  token?: string;
  host?: string;
  port?: number;
}): Promise<BrowserRpcServer> {
  const host = options.host ?? "127.0.0.1";
  if (
    host !== "127.0.0.1" &&
    host !== "::1" &&
    host !== "localhost"
  ) {
    throw new Error(
      "browser RPC server must bind to loopback",
    );
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        if (buffer.length > 1_048_576) {
          socket.destroy();
        }
        return;
      }

      const line = buffer.slice(0, newline);
      void handleLine(line, options).then((response) => {
        socket.end(JSON.stringify(response) + "\n");
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error(
      "browser RPC server did not expose a TCP address",
    );
  }

  return {
    address: "127.0.0.1:" + address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error ? reject(error) : resolve(),
        ),
      ),
  };
}

async function handleLine(
  line: string,
  options: {
    service: BrowserBridgeService;
    token?: string;
  },
): Promise<RpcResponse> {
  let request: RpcRequest;
  try {
    request = JSON.parse(line) as RpcRequest;
  } catch {
    return errorResponse(
      "unknown",
      "invalid_arguments",
      "browser RPC request is not valid JSON",
    );
  }

  const requestId =
    typeof request.request_id === "string"
      ? request.request_id
      : "unknown";

  if (
    options.token !== undefined &&
    request.token !== options.token
  ) {
    return errorResponse(
      requestId,
      "permission_denied",
      "browser bridge authentication failed",
    );
  }

  if (request.type === "handshake") {
    return {
      request_id: requestId,
      status: "success",
      data: {
        protocol_version: "1.0",
        operations: options.service.operations(),
      },
      verification: "not_applicable",
    };
  }

  if (
    request.type !== "invoke" ||
    typeof request.capability !== "string"
  ) {
    return errorResponse(
      requestId,
      "invalid_arguments",
      "browser RPC invoke request is malformed",
    );
  }

  try {
    const result = await options.service.invoke(
      request.capability,
      request.arguments ?? {},
    );
    return {
      request_id: requestId,
      status: "success",
      data: result.data,
      verification: result.verification,
    };
  } catch (error) {
    return errorResponse(
      requestId,
      errorCode(error),
      error instanceof Error
        ? error.message
        : "browser provider failure",
    );
  }
}

function errorResponse(
  requestId: string,
  code: string,
  message: string,
): RpcResponse {
  return {
    request_id: requestId,
    status: "error",
    error: { code, message, details: {} },
    verification: "failed",
  };
}

function codedError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  if (error instanceof BrowserPolicyError) {
    return error.code;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  if (error instanceof TypeError) {
    return "invalid_arguments";
  }
  return "provider_failure";
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw codedError(
      "invalid_arguments",
      key + " must be a non-empty string",
    );
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim()
    ? value
    : undefined;
}

function browserMode(
  args: Record<string, unknown>,
): BrowserMode {
  return args.mode === "foreground_lease"
    ? "foreground_lease"
    : "background_only";
}
