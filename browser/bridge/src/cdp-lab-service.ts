import { BrowserPolicyError } from "./policy.ts";
import {
  BrowserBridgeService,
  type BrowserServiceBackend,
  type BrowserServicePage,
} from "./rpc-server.ts";

/**
 * Test-only, extension-free CDP bridge. This is deliberately not a general
 * website permission system. It only permits one exact local Browser Lab
 * origin in an empty, disposable Tetherplane-owned Chromium profile.
 *
 * Persistent account sessions and real website access require a separate,
 * locally approved, revocable authorization boundary and network interception.
 */
const LAB_OPERATIONS = [
  "status",
  "pages",
  "create_tab",
  "snapshot",
  "navigate",
  "close",
  "act",
  "wait",
] as const;

export class CdpLabOnlyBridgeService extends BrowserBridgeService {
  readonly #backend: BrowserServiceBackend;
  readonly #origin: string;

  constructor(options: {
    backend: BrowserServiceBackend;
    labOrigin: string;
  }) {
    super({ backend: options.backend });
    this.#backend = options.backend;
    this.#origin = requireLoopbackLabOrigin(options.labOrigin);
  }

  override operations(): string[] {
    return [...LAB_OPERATIONS];
  }

  override async invoke(
    capability: string,
    args: Record<string, unknown>,
  ): ReturnType<BrowserBridgeService["invoke"]> {
    const operation = capability.startsWith("browser.")
      ? capability.slice("browser.".length)
      : "";

    if (!LAB_OPERATIONS.some((allowed) => allowed === operation)) {
      throw deny();
    }

    if (operation === "status") {
      const reply = await super.invoke(capability, args);
      const data = reply.data as Record<string, unknown>;
      const capabilities = data.capabilities as Record<string, unknown>;
      return {
        ...reply,
        data: {
          ...data,
          capabilities: {
            ...capabilities,
            operations: this.operations(),
            experimental_local_lab_only: true,
          },
        },
      };
    }

    if (operation === "pages") {
      const pages = await this.#backend.pages();
      return {
        data: {
          pages: pages.filter(
            (page) => page.ownership === "tetherplane" && this.#matches(page.url),
          ),
        },
        verification: "not_applicable",
      };
    }

    if (operation === "create_tab") {
      this.#requireAllowedUrl(args.url);
      const response = await super.invoke(capability, args);
      await this.#verifyPageStillAllowed(
        String((response.data as BrowserServicePage).page_id),
      );
      return response;
    }

    const pageId = args.page_id;
    if (typeof pageId !== "string" || !pageId) {
      throw deny();
    }
    await this.#requireOwnedApprovedPage(pageId);

    if (operation === "navigate") {
      this.#requireAllowedUrl(args.url);
    }

    let reply: Awaited<ReturnType<BrowserBridgeService["invoke"]>>;
    try {
      reply = await super.invoke(capability, args);
    } finally {
      // If the trusted test fixture navigates away during an action, do not
      // continue exposing that page through the service.
      await this.#verifyPageStillAllowed(pageId);
    }
    return reply;
  }

  #matches(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        parsed.origin === this.#origin &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }

  #requireAllowedUrl(value: unknown): void {
    if (typeof value !== "string" || !this.#matches(value)) {
      throw deny();
    }
  }

  async #requireOwnedApprovedPage(pageId: string): Promise<void> {
    const pages = await this.#backend.pages();
    const owned = pages.find((page) => page.page_id === pageId);
    if (
      !owned ||
      owned.ownership !== "tetherplane" ||
      !this.#matches(owned.url)
    ) {
      throw deny();
    }
  }

  async #verifyPageStillAllowed(pageId: string): Promise<void> {
    const pages = await this.#backend.pages();
    const page = pages.find((candidate) => candidate.page_id === pageId);
    if (!page) {
      return;
    }
    if (!this.#matches(page.url)) {
      // A disallowed redirect is not reclassified as an authorized page.
      // The laboratory profile has no credentials; a production broker must
      // additionally block requests *before* cross-origin navigation occurs.
      await this.#backend.close(pageId).catch(() => undefined);
      throw deny();
    }
  }
}

export function requireLoopbackLabOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError("CDP lab origin must be an absolute loopback URL");
  }
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError(
      "CDP lab requires one explicit HTTP loopback origin with a port",
    );
  }
  return parsed.origin;
}

function deny(): BrowserPolicyError {
  return new BrowserPolicyError(
    "permission_denied",
    "operation is outside the explicitly approved local browser lab",
  );
}
