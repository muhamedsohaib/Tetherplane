export type BrowserOwnership =
  | "human"
  | "tetherplane"
  | "shared-observe"
  | "shared-authorized";

export type BrowserOperation =
  | "status"
  | "pages"
  | "snapshot"
  | "navigate"
  | "close"
  | "act"
  | "wait"
  | "upload"
  | "downloads"
  | "diagnostics"
  | "checkpoint";

export type BrowserMode =
  | "background_only"
  | "foreground_lease";

export type BrowserPageRecord = {
  page_id: string;
  ownership: BrowserOwnership;
  active: boolean;
  grant?: {
    operations: BrowserOperation[];
    expires_at_ms?: number;
  };
};

export class BrowserPolicyError extends Error {
  readonly code:
    | "permission_denied"
    | "invalid_arguments";

  constructor(
    code:
      | "permission_denied"
      | "invalid_arguments",
    message: string,
  ) {
    super(message);
    this.name = "BrowserPolicyError";
    this.code = code;
  }
}

const OBSERVE_OPERATIONS =
  new Set<BrowserOperation>([
    "status",
    "pages",
    "snapshot",
    "wait",
    "downloads",
    "diagnostics",
    "checkpoint",
  ]);

export class BrowserOwnershipRegistry {
  readonly #pages =
    new Map<string, BrowserPageRecord>();

  register(page: BrowserPageRecord): void {
    if (!page.page_id.trim()) {
      throw new BrowserPolicyError(
        "invalid_arguments",
        "page_id must be non-empty",
      );
    }

    this.#pages.set(
      page.page_id,
      structuredClone(page),
    );
  }

  get(pageId: string): BrowserPageRecord | undefined {
    const page = this.#pages.get(pageId);

    return page
      ? structuredClone(page)
      : undefined;
  }

  authorize(input: {
    page_id: string;
    operation: BrowserOperation;
    mode: BrowserMode;
  }): BrowserPageRecord {
    const page =
      this.#pages.get(input.page_id);

    if (!page) {
      throw new BrowserPolicyError(
        "invalid_arguments",
        `unknown browser page: ${input.page_id}`,
      );
    }

    if (page.ownership === "tetherplane") {
      return structuredClone(page);
    }

    if (
      OBSERVE_OPERATIONS.has(input.operation)
    ) {
      return structuredClone(page);
    }

    if (
      page.ownership === "shared-authorized" &&
      page.grant?.operations.includes(
        input.operation,
      ) &&
      (
        page.grant.expires_at_ms === undefined ||
        page.grant.expires_at_ms > Date.now()
      )
    ) {
      return structuredClone(page);
    }

    const reason =
      input.mode === "background_only"
        ? "background browser mutation is not authorized for this page"
        : "browser mutation is outside the page ownership grant";

    throw new BrowserPolicyError(
      "permission_denied",
      reason,
    );
  }
}