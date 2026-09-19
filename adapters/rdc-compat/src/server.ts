import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";

import {
  RdcCompatibilityService,
  type AgentCaller,
  type CompatibilityResult,
} from "./service.ts";

export type RdcCompatServerOptions = {
  agentClient: AgentCaller;
  platform?: NodeJS.Platform;
};

const device = z.string().optional();
const loose = z.object({}).loose();

const TOOL_SCHEMAS = {
  list_devices: z.object({}),
  ping: z.object({ deviceId: device }),
  shutdown: z.object({ deviceId: device }),
  get_config: z.object({ deviceId: device }),
  set_config_value: z
    .object({
      key: z.string(),
      value: z.unknown(),
      deviceId: device,
    })
    .loose(),
  read_file: z
    .object({
      path: z.string(),
      isUrl: z.boolean().optional(),
      offset: z.number().int().optional(),
      length: z.number().int().nonnegative().optional(),
      sheet: z.string().optional(),
      range: z.string().optional(),
      deviceId: device,
    })
    .loose(),
  read_multiple_files: z.object({
    paths: z.array(z.string()),
    deviceId: device,
  }),
  write_file: z.object({
    path: z.string(),
    content: z.string(),
    mode: z.enum(["rewrite", "append"]).optional(),
    deviceId: device,
  }),
  create_directory: z.object({
    path: z.string(),
    deviceId: device,
  }),
  list_directory: z.object({
    path: z.string(),
    depth: z.number().int().nonnegative().optional(),
    deviceId: device,
  }),
  move_file: z.object({
    source: z.string(),
    destination: z.string(),
    deviceId: device,
  }),
  get_file_info: z.object({
    path: z.string(),
    deviceId: device,
  }),
  edit_block: z
    .object({
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      expected_replacements: z.number().int().nonnegative().optional(),
      deviceId: device,
    })
    .loose(),
  start_search: z
    .object({
      path: z.string(),
      pattern: z.string(),
      searchType: z.enum(["files", "content"]).optional(),
      literalSearch: z.boolean().optional(),
      ignoreCase: z.boolean().optional(),
      includeHidden: z.boolean().optional(),
      maxResults: z.number().int().positive().optional(),
      contextLines: z.number().int().nonnegative().optional(),
      filePattern: z.string().optional(),
      timeout_ms: z.number().int().nonnegative().optional(),
      earlyTermination: z.boolean().optional(),
      deviceId: device,
    })
    .loose(),
  get_more_search_results: z.object({
    sessionId: z.string(),
    offset: z.number().int().optional(),
    length: z.number().int().positive().optional(),
    deviceId: device,
  }),
  stop_search: z.object({
    sessionId: z.string(),
    deviceId: device,
  }),
  list_searches: z.object({ deviceId: device }),
  start_process: z.object({
    command: z.string(),
    timeout_ms: z.number().int().nonnegative(),
    shell: z.string().optional(),
    verbose_timing: z.boolean().optional(),
    deviceId: device,
  }),
  read_process_output: z.object({
    pid: z.number().int(),
    offset: z.number().int().optional(),
    length: z.number().int().positive().optional(),
    timeout_ms: z.number().int().nonnegative().optional(),
    verbose_timing: z.boolean().optional(),
    deviceId: device,
  }),
  interact_with_process: z.object({
    pid: z.number().int(),
    input: z.string(),
    timeout_ms: z.number().int().nonnegative().optional(),
    wait_for_prompt: z.boolean().optional(),
    verbose_timing: z.boolean().optional(),
    deviceId: device,
  }),
  force_terminate: z.object({
    pid: z.number().int(),
    deviceId: device,
  }),
  list_sessions: z.object({ deviceId: device }),
  list_processes: z.object({ deviceId: device }),
  kill_process: z.object({
    pid: z.number().int(),
    deviceId: device,
  }),
  write_pdf: loose,
  who_am_i: loose,
  get_usage_stats: loose,
  get_recent_tool_calls: loose,
  give_feedback_to_desktop_commander: loose,
  get_prompts: loose,
} as const;

export const RDC_COMPAT_TOOL_NAMES = Object.freeze(
  Object.keys(TOOL_SCHEMAS),
);

export function createRdcCompatMcpServer(
  options: RdcCompatServerOptions,
): McpServer {
  const server = new McpServer({
    name: "tetherplane-rdc-compat",
    version: "0.1.0",
  });
  const service = new RdcCompatibilityService({
    agentClient: options.agentClient,
    ...(options.platform === undefined
      ? {}
      : { platform: options.platform }),
  });

  for (const [name, inputSchema] of Object.entries(
    TOOL_SCHEMAS,
  )) {
    server.registerTool(
      name,
      {
        description:
          "RDC compatibility edge backed by canonical Tetherplane capabilities",
        inputSchema,
      },
      async (input: Record<string, unknown>) =>
        compatibilityResult(
          await service.call(name, input),
        ),
    );
  }
  return server;
}

function compatibilityResult(
  result: CompatibilityResult,
): CallToolResult {
  const structuredContent = result.ok
    ? result.data
    : { error: result.error };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
    ...(!result.ok ? { isError: true } : {}),
  };
}
