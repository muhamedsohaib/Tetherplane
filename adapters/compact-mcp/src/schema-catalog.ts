export type JsonSchema = Record<string, unknown>;

const string = { type: "string" } as const;
const boolean = { type: "boolean" } as const;
const integer = { type: "integer" } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;

function objectSchema(
  required: string[],
  properties: Record<string, unknown>,
): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

const CATALOG: Record<string, JsonSchema> = {
  "device.status": objectSchema([], {}),
  "device.capabilities": objectSchema([], {}),
  "filesystem.read": objectSchema(["path"], {
    path: string,
    offset: integer,
    limit: nonNegativeInteger,
  }),
  "filesystem.read_many": objectSchema(["paths"], {
    paths: { type: "array", items: string, minItems: 1 },
    offset: integer,
    limit: nonNegativeInteger,
  }),
  "filesystem.list": objectSchema(["path"], {
    path: string,
    depth: nonNegativeInteger,
  }),
  "filesystem.info": objectSchema(["path"], { path: string }),
  "filesystem.write": objectSchema(["path", "content"], {
    path: string,
    content: string,
  }),
  "filesystem.append": objectSchema(["path", "content"], {
    path: string,
    content: string,
  }),
  "filesystem.mkdir": objectSchema(["path"], { path: string }),
  "filesystem.move": objectSchema(["source", "destination"], {
    source: string,
    destination: string,
    replace: boolean,
  }),
  "filesystem.patch": objectSchema(["path", "old", "new"], {
    path: string,
    old: string,
    new: string,
    expected_replacements: nonNegativeInteger,
  }),
  "search.start": objectSchema(["root", "scope", "query"], {
    root: string,
    scope: { enum: ["filename", "content"] },
    query: string,
    regex: boolean,
    case_sensitive: boolean,
    include_hidden: boolean,
    max_results: nonNegativeInteger,
    globs: { type: "array", items: string },
    context_lines: nonNegativeInteger,
  }),
  "search.read": objectSchema(["handle"], {
    handle: string,
    max_items: nonNegativeInteger,
  }),
  "search.stop": objectSchema(["handle"], { handle: string }),
  "search.list": objectSchema([], {}),
  "process.run": objectSchema(["program"], {
    program: string,
    args: { type: "array", items: string },
    wait_ms: nonNegativeInteger,
    pty: boolean,
  }),
  "process.read": objectSchema(["handle"], {
    handle: string,
    timeout_ms: nonNegativeInteger,
    mode: { enum: ["unseen", "absolute", "tail"] },
    offset: nonNegativeInteger,
    tail_bytes: nonNegativeInteger,
  }),
  "process.input": objectSchema(["handle", "data"], {
    handle: string,
    data: string,
  }),
  "process.list_sessions": objectSchema([], {}),
  "process.list_system": objectSchema([], {
    max_results: nonNegativeInteger,
  }),
  "process.terminate": objectSchema(["handle"], {
    handle: string,
    grace_ms: nonNegativeInteger,
    force: boolean,
  }),
  "batch.execute": objectSchema(["mode", "operations"], {
    mode: { enum: ["parallel", "sequential"] },
    operations: { type: "array", minItems: 1 },
    stop_on_error: boolean,
  }),
};

export function lookupOperationSchema(
  namespace: string,
  operation: string,
): JsonSchema | null {
  const key = normalizeKey(namespace, operation);
  return CATALOG[key] ?? null;
}

export function listSchemaOperations(namespace: string): string[] {
  const canonicalNamespace =
    namespace === "files" ? "filesystem" : namespace;
  return Object.keys(CATALOG)
    .filter((key) => key.startsWith(`${canonicalNamespace}.`))
    .map((key) => key.slice(canonicalNamespace.length + 1))
    .sort();
}

function normalizeKey(namespace: string, operation: string): string {
  if (namespace === "files") {
    if (operation.startsWith("search")) {
      const searchOperation =
        operation === "search"
          ? "start"
          : operation.replace(/^search_/, "");
      return `search.${searchOperation}`;
    }
    return `filesystem.${operation}`;
  }

  return `${namespace}.${operation}`;
}
