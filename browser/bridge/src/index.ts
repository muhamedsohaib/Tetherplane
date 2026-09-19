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

export type BrowserMode = "background_only" | "foreground_lease";

export type BrowserPageRecord = {
  page_id: string;
  ownership: BrowserOwnership;
  active: boolean;
  grant?: {
    operations: BrowserOperation[];
  };
};

export class BrowserPolicyError extends Error {
  readonly code: "permission_denied" | "invalid_arguments";

  constructor(
    code: "permission_denied" | "invalid_arguments",
    message: string,
  ) {
    super(message);
    this.name = "BrowserPolicyError";
    this.code = code;
  }
}

const OBSERVE_OPERATIONS = new Set<BrowserOperation>([
  "status",
  "pages",
  "snapshot",
  "wait",
  "downloads",
  "diagnostics",
  "checkpoint",
]);

export class BrowserOwnershipRegistry {
  readonly #pages = new Map<string, BrowserPageRecord>();

  register(page: BrowserPageRecord): void {
    if (!page.page_id.trim()) {
      throw new BrowserPolicyError(
        "invalid_arguments",
        "page_id must be non-empty",
      );
    }
    this.#pages.set(page.page_id, structuredClone(page));
  }

  get(pageId: string): BrowserPageRecord | undefined {
    const page = this.#pages.get(pageId);
    return page ? structuredClone(page) : undefined;
  }

  authorize(input: {
    page_id: string;
    operation: BrowserOperation;
    mode: BrowserMode;
  }): BrowserPageRecord {
    const page = this.#pages.get(input.page_id);
    if (!page) {
      throw new BrowserPolicyError(
        "invalid_arguments",
        `unknown browser page: ${input.page_id}`,
      );
    }

    if (page.ownership === "tetherplane") {
      return structuredClone(page);
    }

    if (OBSERVE_OPERATIONS.has(input.operation)) {
      return structuredClone(page);
    }

    if (
      page.ownership === "shared-authorized" &&
      page.grant?.operations.includes(input.operation)
    ) {
      return structuredClone(page);
    }

    const reason =
      input.mode === "background_only"
        ? "background browser mutation is not authorized for this page"
        : "browser mutation is outside the page ownership grant";
    throw new BrowserPolicyError("permission_denied", reason);
  }
}

export type SemanticReference = {
  ref_id: string;
  role: string;
  accessible_name: string;
  ancestry: Array<{
    role: string;
    accessible_name: string;
  }>;
  document_id: string;
  frame_id: string;
  snapshot_revision: number;
};

export {
  SemanticSnapshotEngine,
  StaleReferenceError,
  type BackendSemanticNode,
  type BrowserSemanticSnapshot,
  type SnapshotSemanticNode,
} from "./semantic.ts";

export {
  VerifiedActionEngine,
  type BrowserBridgeBackend,
  type BrowserExpectation,
  type BrowserObservedState,
  type BrowserSemanticAction,
  type ResolvedBrowserAction,
  type VerifiedActionResult,
  type VerifiedActionState,
} from "./action.ts";

export {
  startExtensionBridgeServer,
  type AuthenticatedExtensionClient,
  type ExtensionBridgeMessage,
  type ExtensionBridgeServer,
} from "./extension-session.ts";

export {
  ExtensionBrowserBackend,
  ExtensionBackendError,
  type ExtensionCommandTransport,
  type ExtensionPageInfo,
} from "./extension-backend.ts";
