import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  StaticClientAuthenticator,
} from "../src/auth/static-auth.ts";
import {
  DeviceRegistry,
  hashDeviceCredential,
} from "../src/devices/registry.ts";
import {
  DeviceRouter,
  type RelayToDeviceMessage,
} from "../src/routing/device-router.ts";
import {
  RemoteMcpHttpGateway,
} from "../src/mcp/http-gateway.ts";

test("authenticated Streamable HTTP exposes exactly six compact tools and routes with bound identity", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const observed: RelayToDeviceMessage[] = [];
  let connection = router.connectDevice({
    accountId: "account-a",
    deviceId: "Leno",
    send: async (message) => {
      observed.push(message);
      connection.receive({
        type: "result",
        routeId: message.routeId,
        result: {
          protocol_version: "1.0",
          request_id: message.invocation.request_id,
          status: "success",
          data: { remote: true },
          delta: null,
          error: null,
          verification: "not_applicable",
          continuation: null,
          policy: null,
          timing: { duration_ms: 1 },
        },
      });
    },
  });

  const authenticator = new StaticClientAuthenticator([
    {
      token: "client-token-a",
      accountId: "account-a",
      clientId: "client-a",
      principalId: "human:account-a",
    },
  ]);
  const gateway = new RemoteMcpHttpGateway({
    router,
    authenticator,
  });
  const server = createServer();
  gateway.attach(server, "/mcp");
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
    {
      requestInit: {
        headers: {
          authorization: "Bearer client-token-a",
        },
      },
    },
  );
  const client = new Client(
    { name: "remote-mcp-test", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport as never);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["batch", "browser", "desktop", "device", "files", "process"],
    );

    const result = await client.callTool({
      name: "device",
      arguments: {
        op: "status",
        device: "Leno",
      },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, { remote: true });

    assert.equal(observed.length, 1);
    assert.equal(
      observed[0]?.invocation.principal_id,
      "human:account-a",
    );
    assert.deepEqual(observed[0]?.invocation.actor, {
      id: "client-a",
      kind: "ai_client",
    });
  } finally {
    await client.close().catch(() => undefined);
    await gateway.close();
    await closeServer(server);
  }
});

test("unauthenticated and wrong-token MCP initialization are rejected before session creation", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry });
  const gateway = new RemoteMcpHttpGateway({
    router,
    authenticator: new StaticClientAuthenticator([
      {
        token: "client-token-a",
        accountId: "account-a",
        clientId: "client-a",
        principalId: "human:account-a",
      },
    ]),
  });
  const server = createServer();
  gateway.attach(server, "/mcp");
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    for (const authorization of [undefined, "Bearer wrong-token"]) {
      const response: globalThis.Response = await fetch(
        `http://127.0.0.1:${address.port}/mcp`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(authorization ? { authorization } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: {
                name: "unauthorized-test",
                version: "0.1.0",
              },
            },
          }),
        },
      );
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("mcp-session-id"), null);
    }
  } finally {
    await gateway.close();
    await closeServer(server);
  }
});

async function pairedRegistry(): Promise<DeviceRegistry> {
  const registry = await DeviceRegistry.open();
  const pending = await registry.startPairing({
    deviceId: "Leno",
    credentialHash: hashDeviceCredential(
      "device-secret-for-http-mcp-tests",
    ),
  });
  await registry.approvePairing({
    accountId: "account-a",
    userCode: pending.userCode,
  });
  return registry;
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
