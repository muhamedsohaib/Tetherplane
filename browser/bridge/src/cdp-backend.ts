import type {
  BrowserBridgeBackend,
  BrowserObservedState,
  ResolvedBrowserAction,
} from "./action.ts";
import type { BackendSemanticNode } from "./semantic.ts";

export type CdpTargetInfo = {
  target_id: string;
  type: string;
  url: string;
};

export type CdpFrame = {
  frame_id: string;
  document_id: string;
  parent_frame_id: string | null;
};

export type CdpFrameObservation = {
  url: string;
  semantic_revision: number;
  resource_revision: string | number | null;
  nodes: Array<
    Omit<BackendSemanticNode, "document_id" | "frame_id">
  >;
  validation_messages: string[];
  toasts: string[];
};

export type CdpControl = {
  createTarget(
    url: string,
    background: boolean,
  ): Promise<string>;
  listTargets(): Promise<CdpTargetInfo[]>;
  closeTarget(targetId: string): Promise<void>;
  navigateTarget(targetId: string, url: string): Promise<void>;
  frames(targetId: string): Promise<CdpFrame[]>;
  observeFrame(
    targetId: string,
    frameId: string,
  ): Promise<CdpFrameObservation>;
  performFrame(
    targetId: string,
    frameId: string,
    selectorToken: string,
    action: Record<string, unknown>,
  ): Promise<void>;
  close(): Promise<void>;
};

export type CdpPageInfo = {
  page_id: string;
  target_id: string;
  url: string;
  active: false;
  ownership: "tetherplane";
  backend: "cdp";
};

export type CdpCapabilities = {
  backend: "cdp";
  ownership: "tetherplane_only";
  operations: string[];
  unavailable_operations: string[];
};

export class CdpBackendError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CdpBackendError";
    this.code = code;
  }
}

export class CdpBrowserBackend implements BrowserBridgeBackend {
  readonly #control: CdpControl;
  readonly #ownedTargets = new Set<string>();
  readonly #pollIntervalMs: number;

  constructor(options: {
    control: CdpControl;
    pollIntervalMs?: number;
  }) {
    this.#control = options.control;
    this.#pollIntervalMs = normalizePollInterval(
      options.pollIntervalMs,
    );
  }

  capabilities(): CdpCapabilities {
    return {
      backend: "cdp",
      ownership: "tetherplane_only",
      operations: [
        "pages",
        "create_tab",
        "snapshot",
        "act",
        "wait",
        "navigate",
        "close",
      ],
      unavailable_operations: [
        "attach",
        "detach",
        "upload",
        "downloads",
        "diagnostics",
        "checkpoint",
      ],
    };
  }

  async pages(): Promise<CdpPageInfo[]> {
    const targets = await this.#control.listTargets();
    return targets
      .filter(
        (target) =>
          target.type === "page" &&
          this.#ownedTargets.has(target.target_id),
      )
      .map((target) => ({
        page_id: pageId(target.target_id),
        target_id: target.target_id,
        url: target.url,
        active: false as const,
        ownership: "tetherplane" as const,
        backend: "cdp" as const,
      }));
  }

  async createTab(url: string): Promise<CdpPageInfo> {
    requireHttpUrl(url);
    const targetId = await this.#control.createTarget(url, true);
    this.#ownedTargets.add(targetId);
    return {
      page_id: pageId(targetId),
      target_id: targetId,
      url,
      active: false,
      ownership: "tetherplane",
      backend: "cdp",
    };
  }

  async navigate(
    pageIdValue: string,
    url: string,
  ): Promise<CdpPageInfo> {
    requireHttpUrl(url);
    const targetId = this.#requireOwnedTarget(pageIdValue);
    await this.#control.navigateTarget(targetId, url);
    return {
      page_id: pageIdValue,
      target_id: targetId,
      url,
      active: false,
      ownership: "tetherplane",
      backend: "cdp",
    };
  }

  async close(pageIdValue: string): Promise<void> {
    const targetId = this.#requireOwnedTarget(pageIdValue);
    await this.#control.closeTarget(targetId);
    this.#ownedTargets.delete(targetId);
  }

  async observe(
    pageIdValue: string,
  ): Promise<BrowserObservedState> {
    const targetId = this.#requireOwnedTarget(pageIdValue);
    const frames = await this.#control.frames(targetId);
    if (frames.length === 0) {
      throw new CdpBackendError(
        "provider_failure",
        "CDP target has no observable frames",
      );
    }

    const observations = await Promise.all(
      frames.map(async (frame) => ({
        frame,
        observed: await this.#control.observeFrame(
          targetId,
          frame.frame_id,
        ),
      })),
    );

    const top =
      observations.find(
        (item) => item.frame.parent_frame_id === null,
      ) ?? observations[0]!;
    const nodes: BackendSemanticNode[] = [];

    for (const item of observations) {
      for (const node of item.observed.nodes) {
        nodes.push({
          ...structuredClone(node),
          backend_id: `frame:${item.frame.frame_id}|${node.backend_id}`,
          document_id: item.frame.document_id,
          frame_id: `frame:${item.frame.frame_id}`,
        });
      }
    }

    return {
      page_id: pageIdValue,
      url: top.observed.url,
      semantic_revision: aggregateSemanticRevision(
        observations.map((item) => ({
          frameId: item.frame.frame_id,
          revision: item.observed.semantic_revision,
        })),
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
    pageIdValue: string,
    action: ResolvedBrowserAction,
  ): Promise<void> {
    if (action.kind === "navigate") {
      await this.navigate(pageIdValue, action.url);
      return;
    }

    const targetId = this.#requireOwnedTarget(pageIdValue);
    const parsed = parseBackendId(action.backend_id);
    const frames = await this.#control.frames(targetId);
    if (
      !frames.some(
        (frame) => frame.frame_id === parsed.frameId,
      )
    ) {
      throw new CdpBackendError(
        "stale_reference",
        "CDP frame no longer exists",
      );
    }

    await this.#control.performFrame(
      targetId,
      parsed.frameId,
      parsed.selectorToken,
      action as unknown as Record<string, unknown>,
    );
  }

  async waitForSettled(
    pageIdValue: string,
    afterRevision: number,
    timeoutMs: number,
  ): Promise<BrowserObservedState> {
    const timeout = normalizeTimeout(timeoutMs);
    const deadline = Date.now() + timeout;
    let current = await this.observe(pageIdValue);

    while (
      current.semantic_revision === afterRevision &&
      Date.now() < deadline
    ) {
      await sleep(
        Math.min(
          this.#pollIntervalMs,
          Math.max(0, deadline - Date.now()),
        ),
      );
      current = await this.observe(pageIdValue);
    }

    return current;
  }

  async shutdown(): Promise<void> {
    await this.#control.close();
    this.#ownedTargets.clear();
  }

  #requireOwnedTarget(pageIdValue: string): string {
    const targetId = parsePageId(pageIdValue);
    if (!this.#ownedTargets.has(targetId)) {
      throw new CdpBackendError(
        "permission_denied",
        "CDP target is not owned by Tetherplane",
      );
    }
    return targetId;
  }
}

export function buildIsolatedChromiumArgs(
  profileDir: string,
): string[] {
  if (!profileDir.trim()) {
    throw new TypeError("profileDir must be non-empty");
  }

  return [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-features=Translate",
    "about:blank",
  ];
}

function pageId(targetId: string): string {
  return `cdp:${targetId}`;
}

function parsePageId(value: string): string {
  if (!value.startsWith("cdp:") || value.length <= 4) {
    throw new CdpBackendError(
      "invalid_arguments",
      "CDP page_id is invalid",
    );
  }
  return value.slice(4);
}

function parseBackendId(value: string): {
  frameId: string;
  selectorToken: string;
} {
  if (!value.startsWith("frame:")) {
    throw new CdpBackendError(
      "stale_reference",
      "CDP backend handle is invalid",
    );
  }
  const divider = value.indexOf("|");
  if (divider < 0) {
    throw new CdpBackendError(
      "stale_reference",
      "CDP backend handle is invalid",
    );
  }
  const frameId = value.slice("frame:".length, divider);
  const selectorToken = value.slice(divider + 1);
  if (!frameId || !selectorToken.startsWith("css:")) {
    throw new CdpBackendError(
      "stale_reference",
      "CDP backend handle is invalid",
    );
  }
  return { frameId, selectorToken };
}

function aggregateSemanticRevision(
  values: Array<{ frameId: string; revision: number }>,
): number {
  let hash = 2166136261;
  for (const item of [...values].sort((a, b) =>
    a.frameId.localeCompare(b.frameId),
  )) {
    const text = `${item.frameId}:${item.revision};`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return hash >>> 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function requireHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CdpBackendError(
      "invalid_arguments",
      "browser URL must be absolute",
    );
  }
  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    throw new CdpBackendError(
      "invalid_arguments",
      "browser URL must use http or https",
    );
  }
}

function normalizePollInterval(value: number | undefined): number {
  if (value === undefined) {
    return 25;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("pollIntervalMs must be positive");
  }
  return Math.min(Math.floor(value), 1_000);
}

function normalizeTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("timeoutMs must be positive");
  }
  return Math.min(Math.floor(value), 60_000);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
