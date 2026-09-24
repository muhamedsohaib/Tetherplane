import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { OidcClientAuthenticator } from "../src/auth/oidc-auth.ts";

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

const toolNames = ["batch", "browser", "desktop", "device", "files", "process"];
const oauth = {
  resource: "https://relay.example/mcp",
  issuer: "https://identity.example/",
  scopes: ["tetherplane:access"],
};
const initialize = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "discovery-test", version: "1" } },
};
const toolCall = (name = "device", op = "status") => ({
  jsonrpc: "2.0", id: 3, method: "tools/call",
  params: { name, arguments: { op, device: "Leno", principal_id: "forged", actor: { id: "forged" } } },
});

async function oauthFixture(t: test.TestContext) {
  // Ephemeral signing material stays in memory and is never logged.
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  const claims = { iss: oauth.issuer, aud: oauth.resource, sub: "owner", azp: "client-a", scope: oauth.scopes[0], exp: Math.floor(Date.now() / 1000) + 300 };
  const sign = (changes: Record<string, unknown> = {}) => new SignJWT({ ...claims, ...changes })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).sign(keys.privateKey);
  const identity = { accountId: "account-a", clientId: "client-a", principalId: "human:owner" };
  const alternatives = [
    { ...identity, accountId: "account-b" },
    { ...identity, clientId: "client-b" },
    { ...identity, principalId: "human:other" },
  ];
  const authenticator = new OidcClientAuthenticator({
    issuer: oauth.issuer, audience: oauth.resource, jwksUri: "https://identity.example/jwks", scopes: oauth.scopes,
    bindings: [
      { subject: "owner", ...identity },
      ...alternatives.map((other, i) => ({ subject: `other-${i}`, ...other })),
    ],
  }, createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] }));
  const router = new DeviceRouter({ registry: await pairedRegistry() });
  const routed = t.mock.method(router, "call", async (...[_identity, invocation]: Parameters<DeviceRouter["call"]>): ReturnType<DeviceRouter["call"]> => ({
    protocol_version: "1.0", request_id: invocation.request_id, status: "success",
    data: { remote: true }, delta: null, error: null, verification: "not_applicable",
    continuation: null, policy: null, timing: { duration_ms: 1 },
  }));
  const gateway = new RemoteMcpHttpGateway({ router, authenticator, oauth });
  const server = createServer();
  gateway.attach(server);
  await listen(server);
  t.after(async () => { await gateway.close(); await closeServer(server); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request = (method: string, body?: unknown, session?: string, authorization?: string) => fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method,
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
      ...(authorization === undefined ? {} : { authorization }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const post = (body: unknown, session?: string, authorization?: string) => request("POST", body, session, authorization);
  const discover = async () => {
    const response = await post(initialize);
    assert.equal(response.status, 200);
    const session = response.headers.get("mcp-session-id");
    assert.ok(session);
    const initialized = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    assert.equal(initialized.status, 202);
    return session;
  };
  return { post, request, discover, routed, sign, identity, alternatives };
}

async function assertAuthError(response: Response) {
  assert.equal(response.status, 200);
  const body = await response.json() as { id: number; result: { isError: boolean; _meta: Record<string, string[]> } };
  assert.equal(body.id, 3);
  assert.equal(body.result.isError, true);
  const challenge = body.result._meta["mcp/www_authenticate"]?.[0] ?? "";
  assert.match(challenge, /resource_metadata="https:\/\/relay.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(challenge, /error="invalid_token"/);
  assert.match(challenge, /error_description="Authentication required"/);
}

test("OAuth anonymous discovery initializes and lists exactly six OAuth descriptors without routing", async (t) => {
  const f = await oauthFixture(t);
  const session = await f.discover();
  const response = await f.post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session);
  assert.equal(response.status, 200);
  const body = await response.json() as { result: { tools: Array<{ name: string; securitySchemes: unknown; _meta: { securitySchemes: unknown } }> } };
  assert.deepEqual(body.result.tools.map(tool => tool.name).sort(), toolNames);
  for (const tool of body.result.tools) {
    assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["tetherplane:access"] }]);
    assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes);
  }
  assert.equal(f.routed.mock.callCount(), 0);
});

test("OAuth anonymous sessions challenge every tool including local schema lookup and reject non-discovery requests", async (t) => {
  const f = await oauthFixture(t);
  const session = await f.discover();
  for (const name of toolNames) await assertAuthError(await f.post(toolCall(name), session));
  await assertAuthError(await f.post(toolCall("device", "schema"), session));
  for (const body of [
    { jsonrpc: "2.0", id: 4, method: "resources/list" },
    { jsonrpc: "2.0", method: "tools/call", params: toolCall().params },
    [toolCall(), toolCall("files")],
  ]) assert.equal((await f.post(body, session)).status, 401);
  for (const method of ["GET", "DELETE"]) assert.equal((await f.request(method, undefined, session)).status, 401);
  assert.equal(f.routed.mock.callCount(), 0);
});

test("OAuth binds an anonymous session on a valid call and enforces every identity field on later requests", async (t) => {
  const f = await oauthFixture(t);
  const session = await f.discover();
  const authorization = `Bearer ${await f.sign()}`;
  const response = await f.post(toolCall(), session, authorization);
  assert.equal(response.status, 200);
  const body = await response.json() as { result: { isError?: boolean; structuredContent: unknown } };
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(body.result.structuredContent, { remote: true });
  assert.equal(f.routed.mock.callCount(), 1);
  assert.deepEqual(f.routed.mock.calls[0]?.arguments[0], f.identity);
  for (const [i, other] of f.alternatives.entries()) {
    const different = `Bearer ${await f.sign({ sub: `other-${i}`, azp: other.clientId })}`;
    assert.equal((await f.post(toolCall(), session, different)).status, 403);
    for (const method of ["GET", "DELETE"]) assert.equal((await f.request(method, undefined, session, different)).status, 403);
  }
  await assertAuthError(await f.post(toolCall(), session));
  assert.equal((await f.post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session)).status, 401);
  assert.equal(f.routed.mock.callCount(), 1);
  assert.equal((await f.post(toolCall(), session, authorization)).status, 200);
  assert.equal(f.routed.mock.callCount(), 2);
});

test("OAuth malformed expired wrong-audience and rejected tokens cannot create bind or execute sessions", async (t) => {
  const f = await oauthFixture(t);
  const session = await f.discover();
  const rejected = ["Bearer malformed", "Basic invalid", "Bearer", "",
    ...await Promise.all([{ exp: 1 }, { aud: "wrong" }, { iss: "https://wrong.example/" }, { scope: "other" }, { sub: "unknown" }].map(async claims => `Bearer ${await f.sign(claims)}`))];
  for (const bound of [false, true]) {
    if (bound) assert.equal((await f.post(toolCall(), session, `Bearer ${await f.sign()}`)).status, 200);
    for (const authorization of rejected) {
      const init = await f.post(initialize, undefined, authorization);
      assert.equal(init.status, 401);
      assert.equal(init.headers.get("mcp-session-id"), null);
      await assertAuthError(await f.post(toolCall(), session, authorization));
      assert.equal((await f.post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, session, authorization)).status, 401);
    }
    assert.equal(f.routed.mock.callCount(), bound ? 1 : 0);
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
