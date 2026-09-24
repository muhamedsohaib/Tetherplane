import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

import type {
  InvocationEnvelope,
  ResultEnvelope,
} from "@tetherplane/protocol";

import {
  lookupOperationSchema,
  listSchemaOperations,
} from "./schema-catalog.ts";
import {
  translateAgentResult,
  translateCompactCall,
  type CompactToolInput,
} from "./translate.ts";

export type AgentCaller = {
  call(invocation: InvocationEnvelope): Promise<ResultEnvelope>;
};

export type CompactServerOptions = {
  agentClient: AgentCaller;
  sessionId?: string;
  oauthScopes?: string[];
};

const commonInputSchema = z.object({
  op: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  response_mode: z
    .enum(["compact", "normal", "debug"])
    .default("compact"),
  device: z.string().optional(),
  idempotency_key: z.string().optional(),
  job_id: z.string().optional(),
});

const TOOL_NAMES = [
  "device",
  "files",
  "process",
  "browser",
  "desktop",
  "batch",
] as const;

type ToolName = (typeof TOOL_NAMES)[number];

const TOOL_METADATA: Record<
  ToolName,
  {
    title: string;
    description: string;
    annotations: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      openWorldHint: boolean;
    };
  }
> = {
  device: {
    title: "Tetherplane Device",
    description:
      "Inspect Tetherplane device status and capabilities, and retrieve operation schemas. This tool is read-only.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  files: {
    title: "Tetherplane Files",
    description:
      "Read, search, write, patch, list, inspect, create, and move files within locally authorized paths. Local policy remains authoritative.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  process: {
    title: "Tetherplane Process",
    description:
      "Run and interact with Tetherplane-owned processes, inspect sessions and system processes, and terminate only policy-authorized sessions.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
  browser: {
    title: "Tetherplane Browser",
    description:
      "Inspect and automate authorized browser pages with semantic background-safe operations. Browser actions may navigate or mutate external web applications under local policy.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
  desktop: {
    title: "Tetherplane Desktop",
    description:
      "Inspect and act on authorized desktop UI with semantic automation, a private clipboard, and scoped foreground leases for physical fallback.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
  batch: {
    title: "Tetherplane Batch",
    description:
      "Execute multiple canonical Tetherplane operations in bounded parallel or sequential batches. Every child operation is independently policy-checked.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  },
};

export function createCompactMcpServer(
  options: CompactServerOptions,
): McpServer {
  const server = new McpServer({
    name: "tetherplane",
    version: "0.1.0",
  });

  for (const name of TOOL_NAMES) {
    const metadata = TOOL_METADATA[name];
    server.registerTool(
      name,
      {
        title: metadata.title,
        description: metadata.description,
        annotations: metadata.annotations,
        inputSchema: commonInputSchema,
        ...(options.oauthScopes ? { _meta: { securitySchemes: [{ type: "oauth2", scopes: options.oauthScopes }] } } : {}),
      },
      async (input) => {
        const compactInput = input as CompactToolInput;
        if (name === "device" && compactInput.op === "schema") {
          return schemaLookupResult(compactInput.args);
        }

        const invocation = translateCompactCall(
          name,
          compactInput,
          options.sessionId === undefined
            ? {}
            : { sessionId: options.sessionId },
        );
        const result = await options.agentClient.call(invocation);
        return translateAgentResult(result);
      },
    );
  }

  if (options.oauthScopes) {
    const securitySchemes = [{ type: "oauth2", scopes: [...options.oauthScopes] }];
    // SDK 1.x registerTool drops extension fields outside _meta.
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_NAMES.map((name) => {
        const metadata = TOOL_METADATA[name];
        return {
          name,
          title: metadata.title,
          description: metadata.description,
          annotations: metadata.annotations,
          inputSchema: z.toJSONSchema(commonInputSchema, { io: "input" }) as { type: "object" },
          securitySchemes,
          _meta: { securitySchemes },
        };
      }),
    }));
  }
  return server;
}

function schemaLookupResult(
  args: Record<string, unknown> | undefined,
): import("@modelcontextprotocol/sdk/types.js").CallToolResult {
  const namespace =
    typeof args?.namespace === "string" ? args.namespace : null;
  const operation =
    typeof args?.operation === "string" ? args.operation : null;

  if (!namespace || !operation) {
    return localToolError(
      "invalid_arguments",
      "device schema requires string args.namespace and args.operation",
      null,
      {},
    );
  }

  const schema = lookupOperationSchema(namespace, operation);
  if (!schema) {
    return localToolError(
      "invalid_arguments",
      `schema is unavailable for ${namespace}.${operation}`,
      "request one of the available operations for this namespace",
      {
        namespace,
        operation,
        available_operations: listSchemaOperations(namespace),
      },
    );
  }

  const structuredContent = {
    namespace,
    operation,
    schema,
  };
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

function localToolError(
  code: string,
  message: string,
  recoveryHint: string | null,
  details: Record<string, unknown>,
): import("@modelcontextprotocol/sdk/types.js").CallToolResult {
  const structuredContent = {
    error: {
      code,
      message,
      recovery_hint: recoveryHint,
      details,
    },
  };

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
