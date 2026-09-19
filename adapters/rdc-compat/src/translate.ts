import { randomUUID } from "node:crypto";

import type { InvocationEnvelope } from "@tetherplane/protocol";

export type RdcCompatibilityError = {
  code: "capability_unavailable" | "invalid_arguments";
  message: string;
  recovery_hint: string | null;
  details: Record<string, unknown>;
};

export type RdcTranslation =
  | { kind: "invoke"; invocation: InvocationEnvelope }
  | { kind: "unsupported"; error: RdcCompatibilityError };

export function translateRdcCall(
  tool: string,
  input: Record<string, unknown>,
): RdcTranslation {
  switch (tool) {
    case "read_file":
      return translateReadFile(input);
    case "read_multiple_files":
      return invoke(
        "filesystem.read_many",
        pickDefined(input, ["paths"]),
        input,
      );
    case "write_file":
      return translateWriteFile(input);
    case "create_directory":
      return invoke(
        "filesystem.mkdir",
        pickDefined(input, ["path"]),
        input,
      );
    case "list_directory":
      return invoke(
        "filesystem.list",
        mapKeys(input, {
          path: "path",
          depth: "depth",
        }),
        input,
      );
    case "move_file":
      return invoke(
        "filesystem.move",
        mapKeys(input, {
          source: "source",
          destination: "destination",
        }),
        input,
      );
    case "get_file_info":
      return invoke(
        "filesystem.info",
        pickDefined(input, ["path"]),
        input,
      );
    case "edit_block":
      return translateEditBlock(input);
    case "start_search":
      return translateStartSearch(input);
    case "get_more_search_results":
      return translateSearchRead(input);
    case "stop_search":
      return invoke(
        "search.stop",
        { handle: input.sessionId },
        input,
      );
    case "list_searches":
      return invoke("search.list", {}, input);
    case "write_pdf":
      return unsupported(
        "write_pdf requires a document provider; Plan C does not emulate PDF mutation through filesystem compatibility",
      );
    case "who_am_i":
    case "get_usage_stats":
    case "get_recent_tool_calls":
    case "give_feedback_to_desktop_commander":
    case "get_prompts":
      return unsupported(
        `${tool} is an RDC service/meta capability and has no canonical machine-control equivalent`,
      );
    case "set_config_value":
      return unsupported(
        "runtime policy mutation is intentionally unavailable through the RDC compatibility edge",
      );
    case "shutdown":
      return unsupported(
        "device shutdown is not exposed until a canonical approval-gated system capability exists",
      );
    default:
      return unsupported(
        `RDC compatibility tool is unavailable: ${tool}`,
      );
  }
}

function translateReadFile(
  input: Record<string, unknown>,
): RdcTranslation {
  if (
    input.isUrl === true ||
    input.sheet !== undefined ||
    input.range !== undefined
  ) {
    return unsupported(
      "URL and document/spreadsheet-specialized read_file modes require dedicated providers",
    );
  }
  return invoke(
    "filesystem.read",
    mapKeys(input, {
      path: "path",
      offset: "offset",
      length: "length",
    }),
    input,
  );
}

function translateWriteFile(
  input: Record<string, unknown>,
): RdcTranslation {
  const mode = input.mode ?? "rewrite";
  if (mode !== "rewrite" && mode !== "append") {
    return invalid("write_file mode must be rewrite or append");
  }
  return invoke(
    mode === "append" ? "filesystem.append" : "filesystem.write",
    pickDefined(input, ["path", "content"]),
    input,
  );
}

function translateEditBlock(
  input: Record<string, unknown>,
): RdcTranslation {
  if (
    typeof input.file_path !== "string" ||
    typeof input.old_string !== "string" ||
    typeof input.new_string !== "string"
  ) {
    return invalid(
      "text edit_block requires file_path, old_string and new_string strings",
    );
  }
  return invoke(
    "filesystem.patch",
    {
      path: input.file_path,
      old: input.old_string,
      new: input.new_string,
      expected_replacements:
        input.expected_replacements === undefined
          ? 1
          : input.expected_replacements,
    },
    input,
  );
}

function translateStartSearch(
  input: Record<string, unknown>,
): RdcTranslation {
  if (
    typeof input.path !== "string" ||
    typeof input.pattern !== "string"
  ) {
    return invalid("start_search requires path and pattern strings");
  }
  const searchType = input.searchType ?? "files";
  if (searchType !== "files" && searchType !== "content") {
    return invalid("searchType must be files or content");
  }

  const args: Record<string, unknown> = {
    root: input.path,
    scope: searchType === "files" ? "filename" : "content",
    query: input.pattern,
    regex: input.literalSearch === true ? false : true,
    case_sensitive: input.ignoreCase === false,
    include_hidden: input.includeHidden === true,
  };
  if (input.maxResults !== undefined) {
    args.max_results = input.maxResults;
  }
  if (input.contextLines !== undefined) {
    args.context_lines = input.contextLines;
  }
  if (
    searchType === "content" &&
    typeof input.filePattern === "string" &&
    input.filePattern.length > 0
  ) {
    args.globs = input.filePattern
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return invoke("search.start", args, input);
}

function translateSearchRead(
  input: Record<string, unknown>,
): RdcTranslation {
  if (typeof input.sessionId !== "string") {
    return invalid("get_more_search_results requires sessionId");
  }
  const offset = input.offset ?? 0;
  if (offset !== 0) {
    return unsupported(
      "non-zero RDC search offsets require adapter-side replay state and are not available in the stateless translator",
    );
  }
  return invoke(
    "search.read",
    {
      handle: input.sessionId,
      ...(input.length === undefined
        ? {}
        : { max_items: input.length }),
    },
    input,
  );
}

function invoke(
  capability: string,
  argumentsValue: Record<string, unknown>,
  source: Record<string, unknown>,
): RdcTranslation {
  return {
    kind: "invoke",
    invocation: {
      protocol_version: "1.0",
      request_id: randomUUID(),
      device_id:
        typeof source.deviceId === "string"
          ? source.deviceId
          : null,
      principal_id: null,
      job_id: null,
      capability,
      arguments: argumentsValue,
      actor: { id: "rdc-compat", kind: "ai_client" },
      session_id: null,
      response_mode: "compact",
      idempotency_key: null,
      preconditions: [],
      expectations: [],
    },
  };
}

function mapKeys(
  input: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [source, destination] of Object.entries(mapping)) {
    if (input[source] !== undefined) {
      result[destination] = input[source];
    }
  }
  return result;
}

function pickDefined(
  input: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  return mapKeys(
    input,
    Object.fromEntries(keys.map((key) => [key, key])),
  );
}

function invalid(message: string): RdcTranslation {
  return {
    kind: "unsupported",
    error: {
      code: "invalid_arguments",
      message,
      recovery_hint: null,
      details: {},
    },
  };
}

function unsupported(message: string): RdcTranslation {
  return {
    kind: "unsupported",
    error: {
      code: "capability_unavailable",
      message,
      recovery_hint: null,
      details: {},
    },
  };
}
