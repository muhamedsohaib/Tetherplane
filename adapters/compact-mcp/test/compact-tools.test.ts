import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactMcpServer } from "../src/compact-tools.ts";

test("exposes exactly the six canonical compact tools", async () => {
  const server = createCompactMcpServer({
    agentClient: {
      call: async () => {
        throw new Error("tool-list test should not invoke the agent");
      },
    },
  });
  const client = new Client(
    { name: "compact-tools-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["batch", "browser", "desktop", "device", "files", "process"],
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});


test("advertises review-grade tool metadata with and without OAuth", async () => {
  const expected = {
    device: {
      title: "Tetherplane Device",
      description:
        "Inspect device status and capabilities, retrieve operation schemas, and manage authorized Tetherplane job, checkpoint, lease, and audit state.",
      annotations: {
        readOnlyHint: false,
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
  } as const;

  for (const oauthScopes of [null, ["tetherplane:control"]]) {
    const server = createCompactMcpServer({
      ...(oauthScopes ? { oauthScopes } : {}),
      agentClient: {
        call: async () => {
          throw new Error("tool metadata test should not invoke the agent");
        },
      },
    });
    const client = new Client(
      {
        name: oauthScopes ? "oauth-metadata-test" : "metadata-test",
        version: "0.1.0",
      },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const listed = await client.listTools();
      const actual = Object.fromEntries(
        listed.tools.map((tool) => [
          tool.name,
          {
            title: tool.title,
            description: tool.description,
            annotations: tool.annotations,
          },
        ]),
      );
      assert.deepEqual(actual, expected);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  }
});

test("callTool routes through AgentClient and returns compact structured success", async () => {
  const seen: import("@tetherplane/protocol").InvocationEnvelope[] = [];
  const server = createCompactMcpServer({
    sessionId: "mcp-session-11",
    agentClient: {
      call: async (invocation) => {
        seen.push(invocation);
        return {
          protocol_version: "1.0",
          request_id: invocation.request_id,
          status: "success",
          data: { text: "hello", bytes: 5 },
          delta: null,
          error: null,
          verification: "verified",
          continuation: null,
          policy: null,
          timing: { duration_ms: 3 },
        };
      },
    },
  });
  const client = new Client(
    { name: "compact-call-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "files",
      arguments: {
        op: "read",
        args: { path: "README.md" },
        device: "Leno",
      },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.capability, "filesystem.read");
    assert.equal(seen[0]?.session_id, "mcp-session-11");
    assert.equal(seen[0]?.device_id, "Leno");
    assert.deepEqual(seen[0]?.arguments, { path: "README.md" });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      text: "hello",
      bytes: 5,
    });
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("callTool preserves machine-readable capability errors and policy metadata", async () => {
  const server = createCompactMcpServer({
    agentClient: {
      call: async (invocation) => ({
        protocol_version: "1.0",
        request_id: invocation.request_id,
        status: "error",
        data: null,
        delta: null,
        error: {
          code: "capability_unavailable",
          message: "browser provider is not installed",
          recovery_hint: "install a browser provider",
          details: { namespace: "browser" },
        },
        verification: "failed",
        continuation: null,
        policy: {
          decision: "deny",
          reason: "provider unavailable",
        },
        timing: { duration_ms: 1 },
      }),
    },
  });
  const client = new Client(
    { name: "compact-error-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "browser",
      arguments: { op: "inspect", args: {} },
    });

    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      error: {
        code: "capability_unavailable",
        message: "browser provider is not installed",
        recovery_hint: "install a browser provider",
        details: { namespace: "browser" },
      },
      policy: {
        decision: "deny",
        reason: "provider unavailable",
      },
    });
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("device schema returns one local operation schema without calling agent", async () => {
  let calls = 0;
  const server = createCompactMcpServer({
    agentClient: {
      call: async (invocation) => {
        calls += 1;
        throw new Error(`schema lookup unexpectedly called ${invocation.capability}`);
      },
    },
  });
  const client = new Client(
    { name: "schema-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "device",
      arguments: {
        op: "schema",
        args: {
          namespace: "filesystem",
          operation: "read",
        },
      },
    });

    assert.equal(calls, 0);
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      namespace: "filesystem",
      operation: "read",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer", minimum: 0 },
        },
      },
    });
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("device capabilities is queried from the agent", async () => {
  const capabilities = {
    providers: [
      { namespace: "device", available: true },
      { namespace: "browser", available: false },
    ],
  };
  const seen: string[] = [];
  const server = createCompactMcpServer({
    agentClient: {
      call: async (invocation) => {
        seen.push(invocation.capability);
        return {
          protocol_version: "1.0",
          request_id: invocation.request_id,
          status: "success",
          data: capabilities,
          delta: null,
          error: null,
          verification: "not_applicable",
          continuation: null,
          policy: null,
          timing: { duration_ms: 0 },
        };
      },
    },
  });
  const client = new Client(
    { name: "capabilities-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const result = await client.callTool({
      name: "device",
      arguments: { op: "capabilities" },
    });

    assert.deepEqual(seen, ["device.capabilities"]);
    assert.deepEqual(result.structuredContent, capabilities);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
