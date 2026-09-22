import {
  BrowserPolicyError,
} from "@tetherplane/browser-bridge/policy";

import type {
  BackendSemanticNode,
  BrowserObservedState,
} from "@tetherplane/browser-bridge";

type PageRecord = {
  page_id: string;
  tab_id: number;
  url: string;
  ownership: "human" | "tetherplane" | "shared-observe" | "shared-authorized";
  grant?: {
    operations: string[];
  };
};

export type PageAgentController = {
  pages(): PageRecord[];
  navigate(pageId: string, url: string): Promise<unknown>;
};

export type ChromeInjectionResult = {
  frameId: number;
  documentId?: string;
  result?: unknown;
};

export type ChromeScriptingApi = {
  executeScript(
    injection: Record<string, unknown>,
  ): Promise<ChromeInjectionResult[]>;
};

type RawSemanticNode = Omit<
  BackendSemanticNode,
  "document_id" | "frame_id"
>;

type FrameObservation = {
  url: string;
  semantic_revision: number;
  resource_revision: string | number | null;
  nodes: RawSemanticNode[];
  validation_messages: string[];
  toasts: string[];
};

export class ChromePageAgentError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ChromePageAgentError";
    this.code = code;
  }
}

export class ChromePageAgent {
  readonly #controller: PageAgentController;
  readonly #scripting: ChromeScriptingApi;

  constructor(options: {
    controller: PageAgentController;
    scripting: ChromeScriptingApi;
  }) {
    this.#controller = options.controller;
    this.#scripting = options.scripting;
  }

  async observe(pageId: string): Promise<BrowserObservedState> {
    const page = this.#requirePage(pageId);
    const results = await this.#scripting.executeScript({
      target: {
        tabId: page.tab_id,
        allFrames: true,
      },
      func: collectDocumentSemanticState,
    });

    const observations = results
      .map((result) => ({
        injection: result,
        observed: parseFrameObservation(result.result),
      }))
      .filter(
        (
          item,
        ): item is {
          injection: ChromeInjectionResult;
          observed: FrameObservation;
        } => item.observed !== null,
      );

    if (observations.length === 0) {
      throw new ChromePageAgentError(
        "provider_failure",
        "browser page produced no semantic observation",
      );
    }

    const top =
      observations.find((item) => item.injection.frameId === 0) ??
      observations[0]!;
    const nodes: BackendSemanticNode[] = [];

    for (const item of observations) {
      const frameId = item.injection.frameId;
      const frameName = `frame:${frameId}`;
      const documentId =
        item.injection.documentId ??
        `${pageId}:document:${frameId}`;

      for (const node of item.observed.nodes) {
        nodes.push({
          ...structuredClone(node),
          backend_id: `${frameName}|${node.backend_id}`,
          document_id: documentId,
          frame_id: frameName,
        });
      }
    }

    return {
      page_id: pageId,
      url: top.observed.url,
      semantic_revision: Math.max(
        ...observations.map(
          (item) => item.observed.semantic_revision,
        ),
      ),
      resource_revision: top.observed.resource_revision,
      nodes,
      validation_messages: uniqueStrings(
        observations.flatMap(
          (item) => item.observed.validation_messages,
        ),
      ),
      toasts: uniqueStrings(
        observations.flatMap((item) => item.observed.toasts),
      ),
    };
  }

  async perform(
    pageId: string,
    action: Record<string, unknown>,
  ): Promise<void> {
    const page = this.#requirePage(pageId);
    const kind = requiredString(action, "kind");

    if (kind === "navigate") {
      await this.#controller.navigate(
        pageId,
        requiredString(action, "url"),
      );
      return;
    }

    assertMutationAuthorized(page);

    const backendId = requiredString(action, "backend_id");
    const parsed = parseBackendId(backendId);
    const results = await this.#scripting.executeScript({
      target: {
        tabId: page.tab_id,
        frameIds: [parsed.frameId],
      },
      func: performDocumentAction,
      args: [parsed.selectorToken, structuredClone(action)],
    });

    const result = results[0]?.result;
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      throw new ChromePageAgentError(
        "provider_failure",
        "browser page action returned no result",
      );
    }

    const response = result as Record<string, unknown>;
    if (response.ok === true) {
      return;
    }

    throw new ChromePageAgentError(
      typeof response.code === "string"
        ? response.code
        : "provider_failure",
      typeof response.message === "string"
        ? response.message
        : "browser page action failed",
    );
  }

  #requirePage(pageId: string): PageRecord {
    const page = this.#controller
      .pages()
      .find((candidate) => candidate.page_id === pageId);
    if (!page) {
      throw new ChromePageAgentError(
        "invalid_arguments",
        `unknown browser page: ${pageId}`,
      );
    }
    return structuredClone(page);
  }
}

function assertMutationAuthorized(page: PageRecord): void {
  if (page.ownership === "tetherplane") {
    return;
  }
  if (
    page.ownership === "shared-authorized" &&
    page.grant?.operations.includes("act")
  ) {
    return;
  }
  throw new BrowserPolicyError(
    "permission_denied",
    "semantic mutation is not authorized for this browser page",
  );
}

function parseBackendId(value: string): {
  frameId: number;
  selectorToken: string;
} {
  const match = /^frame:(\d+)\|(css:.+)$/.exec(value);
  if (!match) {
    throw new ChromePageAgentError(
      "stale_reference",
      "browser backend handle is invalid or stale",
    );
  }
  return {
    frameId: Number(match[1]),
    selectorToken: match[2]!,
  };
}

function parseFrameObservation(
  value: unknown,
): FrameObservation | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.url !== "string" ||
    typeof record.semantic_revision !== "number" ||
    !Array.isArray(record.nodes) ||
    !Array.isArray(record.validation_messages) ||
    !Array.isArray(record.toasts)
  ) {
    return null;
  }

  return {
    url: record.url,
    semantic_revision: record.semantic_revision,
    resource_revision:
      typeof record.resource_revision === "string" ||
      typeof record.resource_revision === "number"
        ? record.resource_revision
        : null,
    nodes: record.nodes.filter(isRawSemanticNode),
    validation_messages: record.validation_messages.filter(
      (item): item is string => typeof item === "string",
    ),
    toasts: record.toasts.filter(
      (item): item is string => typeof item === "string",
    ),
  };
}

function isRawSemanticNode(
  value: unknown,
): value is RawSemanticNode {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.backend_id === "string" &&
    typeof record.role === "string" &&
    typeof record.accessible_name === "string"
  );
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ChromePageAgentError(
      "invalid_arguments",
      `${key} must be a non-empty string`,
    );
  }
  return value;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function collectDocumentSemanticState(): FrameObservation {
  const maxNodes = 500;
  const candidates = Array.from(
    document.querySelectorAll(
      [
        "button",
        "input",
        "textarea",
        "select",
        "a[href]",
        "[role]",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
      ].join(","),
    ),
  ).slice(0, maxNodes);

  function normalizedText(value: string | null | undefined): string {
    return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  }

  function roleFor(element: Element): string {
    const explicit = element.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "input") {
      const type = (
        element.getAttribute("type") ?? "text"
      ).toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    return tag;
  }

  function labelText(element: Element): string {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return normalizedText(ariaLabel);

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labels = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (labels.trim()) return normalizedText(labels);
    }

    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      const labels = Array.from(element.labels ?? [])
        .map((label) => label.textContent ?? "")
        .join(" ");
      if (labels.trim()) return normalizedText(labels);
    }

    return normalizedText(
      element.getAttribute("alt") ??
        element.getAttribute("title") ??
        element.textContent,
    );
  }

  function selectorFor(element: Element): string {
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }

    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter(
        (candidate: Element) =>
          candidate.tagName === current!.tagName,
      );
      const position = siblings.indexOf(current) + 1;
      parts.unshift(
        siblings.length > 1
          ? `${tag}:nth-of-type(${position})`
          : tag,
      );
      current = parent;
    }
    return parts.join(" > ");
  }

  function isSensitive(element: Element): boolean {
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }
    const type = element.type.toLowerCase();
    const autocomplete = element.autocomplete.toLowerCase();
    return (
      type === "password" ||
      autocomplete.includes("password") ||
      autocomplete === "one-time-code"
    );
  }

  function valueFor(element: Element): string | undefined {
    if (isSensitive(element)) {
      return undefined;
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return normalizedText(element.value);
    }
    return undefined;
  }

  function stableAncestorName(element: Element): string {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return normalizedText(ariaLabel);
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labels = labelledBy
        .split(/\s+/)
        .map(
          (id) =>
            document.getElementById(id)?.textContent ?? "",
        )
        .join(" ");
      if (labels.trim()) {
        return normalizedText(labels);
      }
    }

    return "";
  }

  function ancestryFor(
    element: Element,
  ): Array<{ role: string; accessible_name: string }> {
    const ancestry: Array<{
      role: string;
      accessible_name: string;
    }> = [];
    let current = element.parentElement;
    while (current && ancestry.length < 4) {
      const role = roleFor(current);
      const name = stableAncestorName(current);
      const tag = current.tagName.toLowerCase();
      const structural =
        tag === "main" ||
        tag === "form" ||
        tag === "fieldset" ||
        tag === "section" ||
        tag === "nav" ||
        tag === "article" ||
        tag === "dialog";

      if (name || current.hasAttribute("role") || structural) {
        ancestry.unshift({
          role,
          accessible_name: name,
        });
      }
      current = current.parentElement;
    }
    return ancestry;
  }

  const nodes: RawSemanticNode[] = [];
  for (const element of candidates) {
    if (
      element.hasAttribute("hidden") ||
      element.getAttribute("aria-hidden") === "true"
    ) {
      continue;
    }

    const sensitive = isSensitive(element);
    const node: RawSemanticNode = {
      backend_id: `css:${selectorFor(element)}`,
      role: roleFor(element),
      accessible_name: labelText(element),
      ancestry: ancestryFor(element),
      sensitive,
    };

    const value = valueFor(element);
    if (value !== undefined) {
      node.value = value;
    }

    if (
      element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      node.disabled = element.disabled;
    }
    if (element instanceof HTMLInputElement) {
      if (
        element.type === "checkbox" ||
        element.type === "radio"
      ) {
        node.checked = element.checked;
      }
    }
    if (element instanceof HTMLOptionElement) {
      node.selected = element.selected;
    }
    nodes.push(node);
  }

  const validationMessages = Array.from(
    document.querySelectorAll(
      '[role="alert"], [aria-invalid="true"], .error, .validation-error',
    ),
  )
    .map((element) => normalizedText(element.textContent))
    .filter(Boolean)
    .slice(0, 50);

  const toasts = Array.from(
    document.querySelectorAll(
      '[role="status"], [aria-live="polite"], [aria-live="assertive"]',
    ),
  )
    .map((element) => normalizedText(element.textContent))
    .filter(Boolean)
    .slice(0, 50);

  const revisionElement = document.querySelector("[data-revision]");
  const resourceRevision =
    revisionElement?.getAttribute("data-revision") ?? null;

  const fingerprintSource = JSON.stringify({
    url: location.href,
    resourceRevision,
    nodes,
    validationMessages,
    toasts,
  });
  let hash = 2166136261;
  for (let index = 0; index < fingerprintSource.length; index += 1) {
    hash ^= fingerprintSource.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return {
    url: location.href,
    semantic_revision: hash >>> 0,
    resource_revision: resourceRevision,
    nodes,
    validation_messages: validationMessages,
    toasts,
  };
}

function performDocumentAction(
  selectorToken: string,
  action: Record<string, unknown>,
): {
  ok: boolean;
  code?: string;
  message?: string;
} {
  if (!selectorToken.startsWith("css:")) {
    return {
      ok: false,
      code: "stale_reference",
      message: "unsupported browser backend selector",
    };
  }

  const selector = selectorToken.slice("css:".length);
  let element: Element | null = null;
  try {
    element = document.querySelector(selector);
  } catch {
    return {
      ok: false,
      code: "stale_reference",
      message: "browser backend selector is no longer valid",
    };
  }

  if (!element) {
    return {
      ok: false,
      code: "stale_reference",
      message: "target no longer exists",
    };
  }

  const kind = action.kind;
  if (kind === "click") {
    if (!(element instanceof HTMLElement)) {
      return {
        ok: false,
        code: "invalid_arguments",
        message: "click target is not an HTML element",
      };
    }
    element.click();
    return { ok: true };
  }

  if (kind === "fill") {
    if (
      !(
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) ||
      typeof action.value !== "string"
    ) {
      return {
        ok: false,
        code: "invalid_arguments",
        message: "fill requires a text input and string value",
      };
    }

    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "value",
    );
    descriptor?.set?.call(element, action.value);
    element.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    element.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    return { ok: true };
  }

  if (kind === "select") {
    if (
      !(element instanceof HTMLSelectElement) ||
      typeof action.value !== "string"
    ) {
      return {
        ok: false,
        code: "invalid_arguments",
        message: "select requires a select element and string value",
      };
    }
    element.value = action.value;
    element.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    element.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    return { ok: true };
  }

  if (kind === "check") {
    if (
      !(element instanceof HTMLInputElement) ||
      typeof action.checked !== "boolean"
    ) {
      return {
        ok: false,
        code: "invalid_arguments",
        message: "check requires an input and boolean checked state",
      };
    }
    element.checked = action.checked;
    element.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
    element.dispatchEvent(
      new Event("change", { bubbles: true }),
    );
    return { ok: true };
  }

  return {
    ok: false,
    code: "invalid_arguments",
    message: "unsupported semantic browser action",
  };
}
