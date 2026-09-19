import {
  SemanticSnapshotEngine,
  StaleReferenceError,
  type BackendSemanticNode,
} from "./semantic.ts";
import type { SemanticReference } from "./index.ts";

export type BrowserObservedState = {
  page_id: string;
  url: string;
  semantic_revision: number;
  resource_revision: string | number | null;
  nodes: BackendSemanticNode[];
  validation_messages: string[];
  toasts: string[];
};

export type ResolvedBrowserAction =
  | {
      kind: "click";
      backend_id: string;
    }
  | {
      kind: "fill";
      backend_id: string;
      value: string;
    }
  | {
      kind: "select";
      backend_id: string;
      value: string;
    }
  | {
      kind: "check";
      backend_id: string;
      checked: boolean;
    }
  | {
      kind: "navigate";
      url: string;
    };

export type BrowserSemanticAction =
  | {
      kind: "click";
      target: SemanticReference;
    }
  | {
      kind: "fill";
      target: SemanticReference;
      value: string;
    }
  | {
      kind: "select";
      target: SemanticReference;
      value: string;
    }
  | {
      kind: "check";
      target: SemanticReference;
      checked: boolean;
    }
  | {
      kind: "navigate";
      url: string;
    };

export type BrowserExpectation =
  | {
      kind: "url";
      equals: string;
    }
  | {
      kind: "value";
      target: SemanticReference;
      equals: string;
    }
  | {
      kind: "validation_absent";
    }
  | {
      kind: "validation_present";
    }
  | {
      kind: "toast";
      includes: string;
    }
  | {
      kind: "text";
      includes: string;
      present?: boolean;
    }
  | {
      kind: "enabled";
      target: SemanticReference;
      equals: boolean;
    }
  | {
      kind: "resource_revision_changed";
      from: string | number | null;
    };

export type BrowserBridgeBackend = {
  observe(pageId: string): Promise<BrowserObservedState>;
  perform(pageId: string, action: ResolvedBrowserAction): Promise<void>;
  waitForSettled(
    pageId: string,
    afterRevision: number,
    timeoutMs: number,
  ): Promise<BrowserObservedState>;
};

export type VerifiedActionState =
  | "verified"
  | "executed_unverified"
  | "precondition_failed"
  | "conflict"
  | "failed";

export type VerifiedActionResult = {
  state: VerifiedActionState;
  before_semantic_revision: number;
  after_semantic_revision: number;
  resource_revision: string | number | null;
  validation_messages: string[];
  toasts: string[];
  error?: {
    code: string;
    message: string;
  };
};

type OwnershipAuthorizer = {
  authorize(input: {
    page_id: string;
    operation:
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
    mode: "background_only" | "foreground_lease";
  }): unknown;
};

export class VerifiedActionEngine {
  readonly #backend: BrowserBridgeBackend;
  readonly #ownership: OwnershipAuthorizer;
  readonly #semantics: SemanticSnapshotEngine;

  constructor(options: {
    backend: BrowserBridgeBackend;
    ownership: OwnershipAuthorizer;
    semantics?: SemanticSnapshotEngine;
  }) {
    this.#backend = options.backend;
    this.#ownership = options.ownership;
    this.#semantics = options.semantics ?? new SemanticSnapshotEngine();
  }

  async execute(request: {
    page_id: string;
    mode: "background_only" | "foreground_lease";
    actions: BrowserSemanticAction[];
    preconditions?: BrowserExpectation[];
    expectations?: BrowserExpectation[];
    expected_resource_revision?: string | number | null;
    timeout_ms?: number;
  }): Promise<VerifiedActionResult> {
    const timeoutMs = normalizeTimeout(request.timeout_ms);
    const before = await this.#backend.observe(request.page_id);
    let current = before;

    if (
      request.expected_resource_revision !== undefined &&
      request.expected_resource_revision !== before.resource_revision
    ) {
      return result("conflict", before, before, {
        code: "resource_conflict",
        message: "browser resource revision changed since checkpoint",
      });
    }

    try {
      if (
        request.preconditions &&
        !this.#expectationsSatisfied(request.preconditions, current)
      ) {
        return result("precondition_failed", before, current, {
          code: "precondition_failed",
          message: "browser action preconditions are not satisfied",
        });
      }
    } catch (error) {
      return this.#semanticFailure(before, current, error);
    }

    for (const action of request.actions) {
      try {
        this.#ownership.authorize({
          page_id: request.page_id,
          operation: action.kind === "navigate" ? "navigate" : "act",
          mode: request.mode,
        });

        const resolved = this.#resolveAction(action, current.nodes);
        await this.#backend.perform(request.page_id, resolved);
        current = await this.#backend.waitForSettled(
          request.page_id,
          current.semantic_revision,
          timeoutMs,
        );
      } catch (error) {
        return this.#semanticFailure(before, current, error);
      }
    }

    if (!request.expectations || request.expectations.length === 0) {
      return result("executed_unverified", before, current);
    }

    try {
      if (this.#expectationsSatisfied(request.expectations, current)) {
        return result("verified", before, current);
      }
    } catch (error) {
      return this.#semanticFailure(before, current, error);
    }

    if (current.validation_messages.length > 0) {
      return result("failed", before, current, {
        code: "validation_failed",
        message: "application validation failed after browser action",
      });
    }

    return result("failed", before, current, {
      code: "verification_failed",
      message: "browser action executed but expectations were not satisfied",
    });
  }

  async wait(request: {
    page_id: string;
    expectations: BrowserExpectation[];
    timeout_ms?: number;
  }): Promise<VerifiedActionResult> {
    const timeoutMs = normalizeTimeout(request.timeout_ms);
    const before = await this.#backend.observe(request.page_id);
    let current = before;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        if (this.#expectationsSatisfied(request.expectations, current)) {
          return result("verified", before, current);
        }
      } catch (error) {
        return this.#semanticFailure(before, current, error);
      }

      const next = await this.#backend.waitForSettled(
        request.page_id,
        current.semantic_revision,
        timeoutMs,
      );
      const unchanged =
        next.semantic_revision === current.semantic_revision &&
        next.resource_revision === current.resource_revision &&
        next.url === current.url;
      current = next;
      if (unchanged) {
        break;
      }
    }

    if (current.validation_messages.length > 0) {
      return result("failed", before, current, {
        code: "validation_failed",
        message: "application validation is present while waiting",
      });
    }

    return result("failed", before, current, {
      code: "semantic_wait_timeout",
      message: "semantic wait ended before expectations were satisfied",
    });
  }

  #resolveAction(
    action: BrowserSemanticAction,
    nodes: BackendSemanticNode[],
  ): ResolvedBrowserAction {
    if (action.kind === "navigate") {
      return {
        kind: "navigate",
        url: action.url,
      };
    }

    const target = this.#semantics.reacquire(action.target, nodes);
    switch (action.kind) {
      case "click":
        return {
          kind: "click",
          backend_id: target.backend_id,
        };
      case "fill":
        return {
          kind: "fill",
          backend_id: target.backend_id,
          value: action.value,
        };
      case "select":
        return {
          kind: "select",
          backend_id: target.backend_id,
          value: action.value,
        };
      case "check":
        return {
          kind: "check",
          backend_id: target.backend_id,
          checked: action.checked,
        };
    }
  }

  #expectationsSatisfied(
    expectations: BrowserExpectation[],
    observed: BrowserObservedState,
  ): boolean {
    return expectations.every((expectation) =>
      this.#expectationSatisfied(expectation, observed),
    );
  }

  #expectationSatisfied(
    expectation: BrowserExpectation,
    observed: BrowserObservedState,
  ): boolean {
    switch (expectation.kind) {
      case "url":
        return observed.url === expectation.equals;
      case "value": {
        const target = this.#semantics.reacquire(
          expectation.target,
          observed.nodes,
        );
        return target.value === expectation.equals;
      }
      case "validation_absent":
        return observed.validation_messages.length === 0;
      case "validation_present":
        return observed.validation_messages.length > 0;
      case "toast":
        return observed.toasts.some((toast) =>
          toast.includes(expectation.includes),
        );
      case "text": {
        const present = observed.nodes.some((node) =>
          [node.accessible_name, node.value, node.description]
            .filter((value): value is string => typeof value === "string")
            .some((value) => value.includes(expectation.includes)),
        );
        return present === (expectation.present ?? true);
      }
      case "enabled": {
        const target = this.#semantics.reacquire(
          expectation.target,
          observed.nodes,
        );
        return !Boolean(target.disabled) === expectation.equals;
      }
      case "resource_revision_changed":
        return observed.resource_revision !== expectation.from;
    }
  }

  #semanticFailure(
    before: BrowserObservedState,
    current: BrowserObservedState,
    error: unknown,
  ): VerifiedActionResult {
    if (error instanceof StaleReferenceError) {
      return result("failed", before, current, {
        code: error.code,
        message: error.message,
      });
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
    ) {
      return result("failed", before, current, {
        code: (error as { code: string }).code,
        message:
          error instanceof Error
            ? error.message
            : "browser action was rejected",
      });
    }

    return result("failed", before, current, {
      code: "provider_failure",
      message:
        error instanceof Error
          ? error.message
          : "browser backend failed unexpectedly",
    });
  }
}

function result(
  state: VerifiedActionState,
  before: BrowserObservedState,
  after: BrowserObservedState,
  error?: { code: string; message: string },
): VerifiedActionResult {
  return {
    state,
    before_semantic_revision: before.semantic_revision,
    after_semantic_revision: after.semantic_revision,
    resource_revision: after.resource_revision,
    validation_messages: [...after.validation_messages],
    toasts: [...after.toasts],
    ...(error ? { error } : {}),
  };
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return 5_000;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeout_ms must be a positive number");
  }
  return Math.min(Math.floor(timeoutMs), 60_000);
}
