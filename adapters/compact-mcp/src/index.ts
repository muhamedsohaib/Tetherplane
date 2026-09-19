export {
  AgentClient,
  AgentDisconnectedError,
  AgentProtocolError,
} from "./agent-client.ts";
export {
  createCompactMcpServer,
  type AgentCaller,
  type CompactServerOptions,
} from "./compact-tools.ts";
export {
  lookupOperationSchema,
  listSchemaOperations,
  type JsonSchema,
} from "./schema-catalog.ts";
export {
  translateAgentResult,
  translateCompactCall,
  type CompactToolInput,
  type CompactToolName,
  type TranslationContext,
} from "./translate.ts";

export const packageName = "@tetherplane/compact-mcp" as const;
