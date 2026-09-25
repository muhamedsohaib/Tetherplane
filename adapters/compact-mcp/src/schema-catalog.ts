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
  "job.create": objectSchema(["objective"], {
    objective: string,
    target_device: string,
    permitted_principals: { type: "array", items: string },
  }),
  "job.get": objectSchema(["job_id"], {
    job_id: string,
  }),
  "job.list": objectSchema([], {
    status: string,
    unleased: boolean,
    limit: { type: "integer", minimum: 1, maximum: 100 },
  }),
  "job.checkpoint": objectSchema(["job_id", "state"], {
    job_id: string,
    state: { type: "object" },
    status: string,
  }),
  "job.acquire_lease": objectSchema(["job_id"], {
    job_id: string,
    ttl_ms: { type: "integer", minimum: 1, maximum: 3_600_000 },
  }),
  "job.release_lease": objectSchema(["job_id"], {
    job_id: string,
    lease_id: string,
  }),
  "audit.read": objectSchema([], {
    job_id: string,
    limit: { type: "integer", minimum: 1, maximum: 500 },
  }),
  "desktop.snapshot": objectSchema([], {
    max_nodes: { type: "integer", minimum: 1, maximum: 1000 },
  }),
  "desktop.act": objectSchema(["reference", "action"], {
    reference: string,
    action: {
      enum: [
        "invoke",
        "set_value",
        "select",
        "toggle",
        "expand",
        "collapse",
      ],
    },
    value: string,
    from_private_clipboard: boolean,
  }),
  "desktop.private_clipboard_get": objectSchema([], {}),
  "desktop.private_clipboard_set": objectSchema([], {
    text: { type: ["string", "null"], maxLength: 1048576 },
    files: {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 4096 },
    },
  }),
  "desktop.foreground_lease_acquire": objectSchema(
    [
      "for_principal_id",
      "target_resource",
      "capabilities",
      "reason",
    ],
    {
      for_principal_id: string,
      target_resource: { enum: ["pointer"] },
      capabilities: {
        type: "array",
        minItems: 1,
        uniqueItems: true,
        items: { enum: ["desktop.physical_pointer_move"] },
      },
      ttl_ms: { type: "integer", minimum: 1, maximum: 120000 },
      reason: string,
    },
  ),
  "desktop.foreground_lease_get": objectSchema(["lease_id"], {
    lease_id: string,
  }),
  "desktop.foreground_lease_release": objectSchema(["lease_id"], {
    lease_id: string,
  }),
  "desktop.physical_pointer_move": objectSchema(
    ["lease_id", "target_resource", "x", "y"],
    {
      lease_id: string,
      target_resource: { enum: ["pointer"] },
      x: integer,
      y: integer,
    },
  ),
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
  if (namespace === "device" && operation.startsWith("job_")) {
    return `job.${operation.slice("job_".length)}`;
  }
  if (namespace === "device" && operation.startsWith("audit_")) {
    return `audit.${operation.slice("audit_".length)}`;
  }
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
