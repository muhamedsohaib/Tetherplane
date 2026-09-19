import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createRdcCompatMcpServer,
  RDC_COMPAT_TOOL_NAMES,
} from "../src/server.ts";

test("RDC compatibility endpoint exposes legacy names without changing compact MCP", async () => {
  const server = createRdcCompatMcpServer({
    agentClient: {
      call: async () => {
        throw new Error("listTools must not invoke the agent");
      },
    },
    platform: "win32",
  });
  const client = new Client(
    { name: "rdc-compat-tools-test", version: "0.1.0" },
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
      [...RDC_COMPAT_TOOL_NAMES].sort(),
    );
    assert.ok(
      listed.tools.some((tool) => tool.name === "read_file"),
    );
    assert.ok(
      listed.tools.some((tool) => tool.name === "start_process"),
    );
    assert.ok(
      listed.tools.some((tool) => tool.name === "write_pdf"),
    );
    assert.equal(
      listed.tools.some((tool) => tool.name === "files"),
      false,
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("unsupported legacy tool returns machine-readable compatibility error", async () => {
  const server = createRdcCompatMcpServer({
    agentClient: {
      call: async () => {
        throw new Error("write_pdf must fail locally");
      },
    },
  });
  const client = new Client(
    { name: "rdc-compat-error-test", version: "0.1.0" },
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
      name: "write_pdf",
      arguments: {
        path: "test.pdf",
        content: "# test",
      },
    });
    assert.equal(result.isError, true);
    assert.equal(
      (
        (result.structuredContent as Record<string, unknown>)
          .error as Record<string, unknown>
      ).code,
      "capability_unavailable",
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
