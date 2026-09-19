import { randomUUID } from "node:crypto";

import type { InvocationEnvelope } from "@tetherplane/protocol";

export type CompactToolName =
  | "device"
  | "files"
  | "process"
  | "browser"
  | "desktop"
  | "batch";

export type CompactToolInput = {
  op: string;
  args?: Record<string, unknown>;
  response_mode?: "compact" | "normal" | "debug";
  device?: string;
  idempotency_key?: string;
};

export type TranslationContext = {
  sessionId?: string;
};

export function translateCompactCall(
  tool: CompactToolName,
  input: CompactToolInput,
  context: TranslationContext = {},
): InvocationEnvelope {
  return {
    protocol_version: "1.0",
    request_id: randomUUID(),
    device_id: input.device ?? null,
    capability: canonicalCapability(tool, input.op),
    arguments: input.args ?? {},
    actor: {
      id: "compact-mcp",
      kind: "ai_client",
    },
    session_id: context.sessionId ?? null,
    response_mode: input.response_mode ?? "compact",
    idempotency_key: input.idempotency_key ?? null,
    preconditions: [],
    expectations: [],
  };
}

function canonicalCapability(
  tool: CompactToolName,
  operation: string,
): string {
  if (tool === "files") {
    switch (operation) {
      case "search":
        return "search.start";
      case "search_read":
        return "search.read";
      case "search_stop":
        return "search.stop";
      case "search_list":
        return "search.list";
      default:
        return `filesystem.${operation}`;
    }
  }

  return `${tool}.${operation}`;
}

export function translateAgentResult(
  result: import("@tetherplane/protocol").ResultEnvelope,
): import("@modelcontextprotocol/sdk/types.js").CallToolResult {
  if (result.status === "success") {
    const structuredContent = result.data ?? {};
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(structuredContent),
        },
      ],
      structuredContent,
    };
  }

  const structuredContent: Record<string, unknown> = {
    error: result.error,
  };
  if (result.policy !== null) {
    structuredContent.policy = result.policy;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
    isError: true,
  };
}
