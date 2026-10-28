import { LocalBrowserLabGrant } from "./local-lab-grant.ts";
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
  readonly #grant: LocalBrowserLabGrant;

  constructor(options: {
    backend: BrowserServiceBackend;
    labOrigin: string;
    grant: LocalBrowserLabGrant;
  }) {
    const origin = requireLoopbackLabOrigin(options.labOrigin);
    const grant = options.grant;
    if (grant.approvedOrigin !== origin) {
      throw new BrowserPolicyError(
        "permission_denied",
        "local grant origin does not match the isolated browser lab",
      );
    }
    super({
      backend: options.backend,
      // This hook runs *before each backend mutation*, not merely once
      // at the start of a multi-action AI request.
      authorizeAction: async ({ pageId, action }) => {
        const pages = await options.backend.pages();
        const page = pages.find((candidate) => candidate.page_id === pageId);
        if (!page || page.ownership !== "tetherplane") throw deny();
        grant.authorize(action.kind === "navigate" ? "navigate" : "act", page.url);
        if (action.kind === "navigate") {
          grant.authorize("navigate", action.url);
        }
      },
    });
    this.#backend = options.backend;
    this.#origin = origin;
    this.#grant = grant;
  }

  override operations(): string[] {
    const available = new Set(this.#grant.operations());
    return LAB_OPERATIONS.filter(
      (op) => op === "status" || available.has(op),
    );
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
          available: this.#grant.isActive,
          capabilities: {
            ...capabilities,
            operations: this.operations(),
            experimental_local_lab_only: true,
            local_grant_active: this.#grant.isActive,
          },
        },
      };
    }

    if (operation === "pages") {
      this.#grant.authorize("pages", this.#origin);
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
      this.#requireAllowedUrl(args.url, "create_tab");
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
    await this.#requireOwnedApprovedPage(pageId, operation);

    if (operation === "navigate") {
      this.#requireAllowedUrl(args.url, "navigate");
    }
    if (operation === "act") {
      // Scan the entire batch before *any* action. A navigate nested
      // inside browser.act must not bypass browser.navigate restrictions.
      const actions = args.actions;
      if (!Array.isArray(actions) || actions.length === 0) throw deny();
      for (const action of actions) {
        if (!action || typeof action !== "object") throw deny();
        const item = action as Record<string, unknown>;
        if (!["fill", "click", "check", "select", "navigate"].includes(
          String(item.kind),
        )) {
          throw deny();
        }
        if (item.kind === "navigate") {
          this.#requireAllowedUrl(item.url, "navigate");
        }
      }
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
    return this.#grant.allowsUrl(url);
  }

  #requireAllowedUrl(
    value: unknown,
    operation: "create_tab" | "navigate",
  ): void {
    if (typeof value !== "string") throw deny();
    this.#grant.authorize(operation, value);
  }

  async #requireOwnedApprovedPage(
    pageId: string,
    operation: string,
  ): Promise<void> {
    const pages = await this.#backend.pages();
    const owned = pages.find((page) => page.page_id === pageId);
    if (!owned || owned.ownership !== "tetherplane") throw deny();
    if (
      !["snapshot", "navigate", "close", "act", "wait"].includes(operation)
    ) {
      throw deny();
    }
    this.#grant.authorize(
      operation as "snapshot" | "navigate" | "close" | "act" | "wait",
      owned.url,
    );
  }

  async #verifyPageStillAllowed(pageId: string): Promise<void> {
    const pages = await this.#backend.pages();
    const page = pages.find((candidate) => candidate.page_id === pageId);
    if (!page) {
      return;
    }
    if (!this.#grant.isActive) throw deny();
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
