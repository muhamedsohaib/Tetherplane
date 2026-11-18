export type DesktopNode = {
  reference: string;
  role?: string;
  name: string;
  automation_id?: string | null;
  class_name?: string | null;
  process_id: number;
  origin: string;
  enabled?: boolean;
  focusable?: boolean;
  focused?: boolean;
  patterns: string[];
};

export type ToolCallResultLike = {
  isError?: unknown;
  structuredContent?: unknown;
  content?: unknown;
  [key: string]: unknown;
};

export type OwnedFixtureTargets = {
  valueNode: DesktopNode;
  invokeNode: DesktopNode;
  selectionNode: DesktopNode | undefined;
  listBoxNode: DesktopNode | undefined;
};

export type NodeDiagnosticSummary = {
  reference: string;
  role: string | null;
  name: string;
  automation_id: string | null;
  class_name: string | null;
  patterns: string[];
  enabled: boolean | null;
  focused: boolean | null;
};

export type ExtractedToolPayload = {
  is_error: boolean;
  structured: Record<string, unknown> | null;
  raw_text: string | null;
};

export function summarizeNodesForDiagnostics(
  nodes: DesktopNode[],
  limit = 50,
): NodeDiagnosticSummary[] {
  return nodes.slice(0, limit).map((node) => ({
    reference: node.reference,
    role: node.role ?? null,
    name: node.name,
    automation_id: node.automation_id ?? null,
    class_name: node.class_name ?? null,
    patterns: [...node.patterns],
    enabled: typeof node.enabled === "boolean" ? node.enabled : null,
    focused: typeof node.focused === "boolean" ? node.focused : null,
  }));
}

export function extractToolPayload(
  result: ToolCallResultLike,
): ExtractedToolPayload {
  const isError = result.isError === true;
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
    return {
      is_error: isError,
      structured: result.structuredContent as Record<string, unknown>,
      raw_text: null,
    };
  }

  const content = Array.isArray(result.content)
    ? (result.content as Array<{ type?: unknown; text?: unknown }>)
    : [];
  const textItem = content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  if (!textItem || typeof textItem.text !== "string") {
    return { is_error: isError, structured: null, raw_text: null };
  }

  try {
    const parsed = JSON.parse(textItem.text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        is_error: isError,
        structured: parsed as Record<string, unknown>,
        raw_text: null,
      };
    }
  } catch {
    // Preserve non-JSON diagnostic body without throwing before logging.
  }

  return {
    is_error: isError,
    structured: null,
    raw_text: textItem.text.slice(0, 2048),
  };
}

export function createBoundedOutputCollector(maxChars = 4096) {
  let buffer = "";
  return {
    append(chunk: Buffer | string) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer += text;
      if (buffer.length > maxChars) {
        buffer = buffer.slice(buffer.length - maxChars);
      }
    },
    read(): string {
      return buffer;
    },
  };
}

const WINDOW_CHROME_AUTOMATION_IDS = new Set([
  "titlebar",
  "minimize",
  "maximize",
  "restore",
  "close",
  "menubar",
  "systemmenubar",
]);

const WINDOW_CHROME_NAMES = new Set([
  "minimize",
  "maximize",
  "restore",
  "close",
  "system",
]);

function isTitleBarNode(node: DesktopNode): boolean {
  const role = (node.role ?? "").trim().toLowerCase();
  const automationId = (node.automation_id ?? "").trim().toLowerCase();
  return role === "title bar" || role === "titlebar" || automationId === "titlebar";
}

function isWindowChromeButton(node: DesktopNode): boolean {
  if (isTitleBarNode(node)) return true;
  const automationId = (node.automation_id ?? "").trim().toLowerCase();
  const name = node.name.trim().toLowerCase();
  return (
    WINDOW_CHROME_AUTOMATION_IDS.has(automationId) ||
    WINDOW_CHROME_NAMES.has(name)
  );
}

export function selectOwnedFixtureTargets(
  ownedNodes: DesktopNode[],
): OwnedFixtureTargets {
  const valueCandidates = ownedNodes.filter(
    (node) => node.patterns.includes("value") && !isTitleBarNode(node),
  );
  const valueNode =
    valueCandidates.find(
      (node) =>
        node.automation_id === "OwnedValue" ||
        node.name.includes("Owned Value"),
    ) ??
    valueCandidates.find((node) => {
      const role = (node.role ?? "").toLowerCase();
      const className = (node.class_name ?? "").toLowerCase();
      return (
        role === "edit" ||
        className.includes("edit") ||
        className.includes("textbox")
      );
    });
  if (!valueNode) {
    throw new Error(
      "expected owned desktop node OwnedValue with value pattern; observed=" +
        JSON.stringify(summarizeNodesForDiagnostics(ownedNodes)),
    );
  }

  const invokeCandidates = ownedNodes.filter(
    (node) => node.patterns.includes("invoke") && !isWindowChromeButton(node),
  );
  const invokeNode =
    invokeCandidates.find(
      (node) =>
        node.automation_id === "OwnedInvoke" ||
        node.name.includes("Owned Invoke"),
    ) ?? invokeCandidates[0];
  if (!invokeNode) {
    throw new Error(
      "expected owned desktop node OwnedInvoke with invoke pattern; observed=" +
        JSON.stringify(summarizeNodesForDiagnostics(ownedNodes)),
    );
  }

  const selectionNode =
    ownedNodes.find(
      (node) =>
        node.patterns.includes("selection") &&
        (node.automation_id === "OwnedBeta" || node.name.includes("Beta")),
    ) ?? ownedNodes.find((node) => node.patterns.includes("selection"));
  const listBoxNode = ownedNodes.find(
    (node) =>
      node.automation_id === "OwnedSelection" ||
      node.name.includes("Owned Selection") ||
      (node.class_name ?? "").toLowerCase().includes("listbox"),
  );
  return { valueNode, invokeNode, selectionNode, listBoxNode };
}

export function selectHumanInvokeTarget(
  humanNodes: DesktopNode[],
): DesktopNode {
  const invokeCandidates = humanNodes.filter(
    (node) => node.patterns.includes("invoke") && !isWindowChromeButton(node),
  );
  const invokeNode =
    invokeCandidates.find(
      (node) =>
        node.automation_id === "HumanInvoke" ||
        node.name.includes("Human Invoke"),
    ) ?? invokeCandidates[0];
  if (!invokeNode) {
    throw new Error(
      "expected human desktop node HumanInvoke with invoke pattern; observed=" +
        JSON.stringify(summarizeNodesForDiagnostics(humanNodes)),
    );
  }
  return invokeNode;
}

export type FixtureStateSnapshot = {
  ready?: unknown;
  content_rendered?: unknown;
  focused?: unknown;
  window_is_active?: unknown;
  window_is_keyboard_focus_within?: unknown;
  hwnd?: unknown;
  os_foreground_available?: unknown;
  os_foreground_hwnd?: unknown;
  os_foreground_pid?: unknown;
  os_foreground_matches_window?: unknown;
  os_foreground_matches_process?: unknown;
  focus_mismatch?: unknown;
  state_seq?: unknown;
  tick_count?: unknown;
  activated_events?: unknown;
  deactivated_events?: unknown;
  write_errors?: unknown;
  last_write_error?: unknown;
  last_source?: unknown;
  updated_at_utc?: unknown;
  text?: unknown;
  selected?: unknown;
  status?: unknown;
  pid?: unknown;
  framework?: unknown;
  [key: string]: unknown;
};

export type ForegroundSnapshotLike = {
  hwnd: number;
  pid: number;
  processName: string;
  className: string;
};

export type FocusCoexistenceVerdict = {
  ready: boolean;
  reason: string;
  discrepancy: string | null;
};

function finitePositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function isFixtureRenderedReady(
  state: FixtureStateSnapshot | null | undefined,
  framework: "WinForms" | "Wpf",
): boolean {
  if (!state) return false;
  const seq = finitePositiveNumber(state.state_seq);
  return (
    state.ready === true &&
    state.content_rendered === true &&
    state.framework === framework &&
    seq !== null
  );
}

export function hasFixtureHeartbeatAdvanced(
  beforeState: FixtureStateSnapshot | null | undefined,
  afterState: FixtureStateSnapshot | null | undefined,
): boolean {
  if (!beforeState || !afterState) return false;
  const beforeSeq = finitePositiveNumber(beforeState.state_seq);
  const afterSeq = finitePositiveNumber(afterState.state_seq);
  const afterTicks = finiteNonNegativeNumber(afterState.tick_count);
  const beforeTicks = finiteNonNegativeNumber(beforeState.tick_count) ?? 0;
  if (beforeSeq === null || afterSeq === null || afterTicks === null) {
    return false;
  }
  return afterSeq > beforeSeq && afterTicks >= Math.max(1, beforeTicks + 1);
}

export function evaluateFocusCoexistence(params: {
  framework: "WinForms" | "Wpf";
  ownedState: FixtureStateSnapshot | null | undefined;
  humanState: FixtureStateSnapshot | null | undefined;
  ownedPid: number;
  humanPid: number;
  foreground: ForegroundSnapshotLike | null;
}): FocusCoexistenceVerdict {
  const { framework, ownedState, humanState, ownedPid, humanPid, foreground } =
    params;

  if (!isFixtureRenderedReady(ownedState, framework)) {
    return {
      ready: false,
      reason: "owned_not_rendered",
      discrepancy: null,
    };
  }
  if (!isFixtureRenderedReady(humanState, framework)) {
    return {
      ready: false,
      reason: "human_not_rendered",
      discrepancy: null,
    };
  }

  if (ownedState?.focused === true && humanState?.focused === true) {
    return {
      ready: false,
      reason: "dual_focused_discrepancy",
      discrepancy:
        "both owned and human fixture states simultaneously reported focused=true " +
        `(owned_pid=${ownedPid}, human_pid=${humanPid}, os_fg_pid=${foreground?.pid ?? "unavailable"})`,
    };
  }

  if (humanState?.focused !== true) {
    return {
      ready: false,
      reason: "human_not_focused",
      discrepancy:
        foreground?.pid === humanPid
          ? `OS foreground is human_pid=${humanPid} but human fixture reported focused=${String(humanState?.focused)}`
          : null,
    };
  }

  if (ownedState?.focused !== false) {
    return {
      ready: false,
      reason: "owned_still_focused",
      discrepancy:
        foreground?.pid === humanPid
          ? `OS foreground is human_pid=${humanPid} but owned fixture reported focused=${String(ownedState?.focused)}`
          : null,
    };
  }

  if (!foreground || foreground.pid <= 0) {
    return {
      ready: false,
      reason: "os_foreground_unavailable",
      discrepancy:
        "independent OS foreground probe did not report a valid foreground window",
    };
  }

  if (foreground.pid === ownedPid) {
    return {
      ready: false,
      reason: "os_foreground_is_owned",
      discrepancy:
        `owned fixture reported focused=false but independent OS foreground is owned_pid=${ownedPid} (hwnd=${foreground.hwnd})`,
    };
  }

  if (foreground.pid !== humanPid) {
    return {
      ready: false,
      reason: "os_foreground_not_human",
      discrepancy:
        `expected OS foreground human_pid=${humanPid}, observed pid=${foreground.pid} (${foreground.processName}, hwnd=${foreground.hwnd})`,
    };
  }

  const ownedHwnd = finitePositiveNumber(ownedState?.hwnd);
  const humanHwnd = finitePositiveNumber(humanState?.hwnd);
  if (ownedHwnd !== null && foreground.hwnd === ownedHwnd) {
    return {
      ready: false,
      reason: "os_foreground_matches_owned_hwnd",
      discrepancy: `independent OS foreground hwnd=${foreground.hwnd} matches owned fixture hwnd`,
    };
  }
  if (humanHwnd !== null && foreground.hwnd !== humanHwnd) {
    return {
      ready: false,
      reason: "os_foreground_hwnd_mismatch",
      discrepancy: `independent OS foreground hwnd=${foreground.hwnd} does not match human fixture hwnd=${humanHwnd}`,
    };
  }

  if (
    ownedState?.os_foreground_available === true &&
    ownedState?.os_foreground_matches_window === true
  ) {
    return {
      ready: false,
      reason: "owned_os_foreground_conflict",
      discrepancy:
        "owned fixture reported os_foreground_matches_window=true while focused=false",
    };
  }

  if (
    humanState?.os_foreground_available === true &&
    humanState?.os_foreground_matches_window === false
  ) {
    return {
      ready: false,
      reason: "human_os_foreground_conflict",
      discrepancy:
        "human fixture reported os_foreground_matches_window=false while focused=true",
    };
  }

  return {
    ready: true,
    reason: "corroborated",
    discrepancy: null,
  };
}
