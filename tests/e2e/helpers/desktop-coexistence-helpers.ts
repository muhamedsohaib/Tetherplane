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
