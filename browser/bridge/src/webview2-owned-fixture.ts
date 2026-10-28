import type {
  BrowserBridgeBackend,
  BrowserObservedState,
  ResolvedBrowserAction,
} from "./action.ts";

/**
 * Local-only disposable WebView2 fixture adapter, NOT a production browser
 * provider, CdpControl, or remotely accessible generic browser RPC.
 * A trusted local caller supplies a narrow native host transport.
 */
export type WebView2OwnedFixtureTransport = {
  request(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export class WebView2FixturePolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WebView2FixturePolicyError";
    this.code = code;
  }
}

const MAX_LOCAL_GRANT_MS = 15 * 60 * 1000;
const FIXTURE_URL = "about:blank";
const BUTTON_ID = "fixture:go";

export class WebView2OwnedFixtureBackend implements BrowserBridgeBackend {
  readonly #transport: WebView2OwnedFixtureTransport;
  readonly #expiresAtMs: number;
  readonly #clock: () => number;
  readonly #owned = new Set<string>();
  #revoked = false;

  constructor(input: {
    transport: WebView2OwnedFixtureTransport;
    expiresAtMs: number;
    clock?: () => number;
  }) {
    const clock = input.clock ?? Date.now;
    const ttlMs = input.expiresAtMs - clock();
    if (!Number.isSafeInteger(input.expiresAtMs) || ttlMs <= 0 || ttlMs > MAX_LOCAL_GRANT_MS) {
      throw new TypeError("WebView2 lab grant must expire within 15 minutes");
    }
    this.#transport = input.transport;
    this.#expiresAtMs = input.expiresAtMs;
    this.#clock = clock;
  }

  capabilities(): { operations: string[]; unavailable_operations: string[] } {
    return {
      operations: ["create_fixture", "snapshot", "click", "close"],
      unavailable_operations: [
        "navigate", "fill", "select", "check", "upload", "downloads",
        "diagnostics", "attach", "arbitrary_cdp",
      ],
    };
  }

  /** Trusted local caller only. No model-facing grant/revoke operation. */
  revoke(): void {
    this.#revoked = true;
  }

  /**
   * Trusted local owner/broker only. Deny new adapter actions immediately,
   * then require an independent acknowledgement from the native host.
   * A failed acknowledgement MUST be treated by the owning supervisor as a
   * host-termination condition, not proof that the host was revoked.
   */
  async revokeAndWait(): Promise<void> {
    this.#revoked = true;
    const response = await this.#transport.request("revoke_fixture", {});
    this.#throwHostFailure(response);
    if (response.revoked !== true) {
      throw new WebView2FixturePolicyError(
        "provider_failure",
        "native WebView2 fixture revocation not acknowledged",
      );
    }
  }

  async createPage(): Promise<{
    page_id: string;
    url: "about:blank";
    active: false;
    ownership: "tetherplane";
  }> {
    this.#requireGrant();
    const response = await this.#transport.request("create_fixture", {});
    this.#throwHostFailure(response);
    const page = response.page_id;
    if (
      typeof page !== "string" ||
      !/^wvlab:[A-Za-z0-9_-]{6,128}$/.test(page) ||
      response.url !== FIXTURE_URL ||
      this.#owned.has(page)
    ) {
      throw new WebView2FixturePolicyError("provider_failure", "native WebView2 returned an invalid owned page");
    }
    // Creating a native controller is asynchronous. An owner may revoke the
    // local grant before it returns; never register the late page as owned.
    if (this.#revoked || this.#clock() >= this.#expiresAtMs) {
      const cleanup = await this.#transport.request("close_fixture", { page_id: page });
      this.#throwHostFailure(cleanup);
      if (cleanup.closed !== true) {
        throw new WebView2FixturePolicyError("provider_failure", "revoked fixture cleanup was not acknowledged");
      }
      throw new WebView2FixturePolicyError("permission_denied", "WebView2 lab grant revoked during page creation");
    }
    this.#owned.add(page);
    return { page_id: page, url: FIXTURE_URL, active: false, ownership: "tetherplane" };
  }

  async observe(pageId: string): Promise<BrowserObservedState> {
    this.#authorize(pageId);
    const response = await this.#transport.request("observe_fixture", { page_id: pageId });
    this.#throwHostFailure(response);
    if (
      response.page_id !== pageId ||
      response.url !== FIXTURE_URL ||
      (response.status !== "initial" && response.status !== "clicked") ||
      !Number.isSafeInteger(response.revision) ||
      (response.revision as number) < 1
    ) {
      throw new WebView2FixturePolicyError("provider_failure", "native observation violated local fixture contract");
    }
    const value = response.status as string;
    return {
      page_id: pageId,
      url: FIXTURE_URL,
      semantic_revision: response.revision as number,
      resource_revision: response.revision as number,
      nodes: [
        {
          backend_id: BUTTON_ID,
          role: "button",
          accessible_name: "GO",
          document_id: "fixture-document:" + pageId,
          frame_id: "fixture-frame:" + pageId,
        },
        {
          backend_id: "fixture:status",
          role: "status",
          accessible_name: value,
          document_id: "fixture-document:" + pageId,
          frame_id: "fixture-frame:" + pageId,
        },
      ],
      validation_messages: [],
      toasts: [],
    };
  }

  async perform(pageId: string, action: ResolvedBrowserAction): Promise<void> {
    this.#authorize(pageId);
    if (action.kind !== "click") {
      throw new WebView2FixturePolicyError(
        "capability_unavailable",
        "WebView2 fixture supports no remote navigation or input modification",
      );
    }
    if (action.backend_id !== BUTTON_ID) {
      throw new WebView2FixturePolicyError("permission_denied", "only the owned fixture button may be clicked");
    }
    const response = await this.#transport.request("click_fixture", { page_id: pageId, element: "go" });
    this.#throwHostFailure(response);
    if (response.clicked !== true) {
      throw new WebView2FixturePolicyError("provider_failure", "native click not acknowledged");
    }
  }

  async waitForSettled(pageId: string, afterRevision: number, timeoutMs: number): Promise<BrowserObservedState> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("invalid wait timeout");
    const deadline = Date.now() + Math.min(timeoutMs, 10_000);
    let state = await this.observe(pageId);
    while (state.semantic_revision === afterRevision && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
      state = await this.observe(pageId);
    }
    return state;
  }

  async closePage(pageId: string): Promise<void> {
    this.#requireOwned(pageId);
    const response = await this.#transport.request("close_fixture", { page_id: pageId });
    this.#throwHostFailure(response);
    if (response.closed !== true) {
      throw new WebView2FixturePolicyError("provider_failure", "native close not acknowledged");
    }
    this.#owned.delete(pageId);
  }

  #authorize(pageId: string): void {
    this.#requireGrant();
    this.#requireOwned(pageId);
  }

  #requireGrant(): void {
    if (this.#revoked || this.#clock() >= this.#expiresAtMs) {
      throw new WebView2FixturePolicyError("permission_denied", "WebView2 lab grant expired or revoked");
    }
  }

  #requireOwned(pageId: string): void {
    if (!this.#owned.has(pageId)) {
      throw new WebView2FixturePolicyError("permission_denied", "WebView2 page is not owned");
    }
  }

  #throwHostFailure(response: Record<string, unknown>): void {
    if (typeof response !== "object" || response === null) {
      throw new WebView2FixturePolicyError("provider_failure", "invalid WebView2 native response");
    }
    if ("error" in response) {
      throw new WebView2FixturePolicyError("permission_denied", "WebView2 native host denied operation");
    }
  }
}
