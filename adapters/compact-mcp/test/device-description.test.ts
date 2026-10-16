import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createCompactMcpServer } from "../src/compact-tools.ts";

async function listTools(oauthScopes?: string[]) {
  const server = createCompactMcpServer({
    ...(oauthScopes ? { oauthScopes } : {}),
    agentClient: {
      call: async () => {
        throw new Error("tool-list test should not invoke the agent");
      },
    },
  });
  const client = new Client(
    { name: "device-description-test", version: "0.1.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

for (const [label, scopes] of [
  ["plain", undefined],
  ["oauth", ["tetherplane:access"]],
] as const) {
  test(`device tool describes the relay-side pairing approval (${label})`, async () => {
    const tools = await listTools(scopes ? [...scopes] : undefined);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["batch", "browser", "desktop", "device", "files", "process"],
    );

    const device = tools.find((tool) => tool.name === "device");
    assert.ok(device);
    const description = device.description ?? "";
    assert.match(description, /approve_pairing/);
    assert.match(description, /userCode/);
    assert.match(description, /expectedDeviceId/);
    assert.match(description, /not read-only/i);

    for (const tool of tools) {
      if (tool.name !== "device") {
        assert.doesNotMatch(tool.description ?? "", /approve_pairing/);
      }
      assert.notEqual(tool.annotations?.readOnlyHint, true);
    }
  });
}
