import assert from "node:assert/strict";
import test from "node:test";
import { RelayServer } from "../src/server.ts";
import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";

const oauth = { resource: "https://relay.example/mcp", issuer: "https://identity.example/", scopes: ["tetherplane:access"] };
test("OAuth edge advertises trusted discovery, preserves six tools and challenges expired sessions without routing", async () => {
  const relay = await RelayServer.create({ allowInsecureLocalhost: true, oauth,
    authenticator: new StaticClientAuthenticator([{ token: "test-only", accountId: "a", clientId: "c", principalId: "p" }]) });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const post = (body: unknown, extra: Record<string,string> = {}) => fetch(address.mcpUrl, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    const denied = await fetch(address.mcpUrl, { headers: { ...headers, authorization: "Bearer invalid" } });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/relay.example\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.equal(denied.headers.get("mcp-session-id"), null);
    for (const suffix of ["", "/mcp"]) {
      const response = await fetch(address.httpUrl + "/.well-known/oauth-protected-resource" + suffix, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { resource: oauth.resource, authorization_servers: [oauth.issuer], scopes_supported: oauth.scopes, bearer_methods_supported: ["header"] });
    }
    const init = await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, { authorization: "Bearer test-only" });
    assert.equal(init.status, 200);
    await init.json();
    const session = init.headers.get("mcp-session-id")!;
    assert.ok(session);
    const listed = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { authorization: "Bearer test-only", "mcp-session-id": session });
    const data = await listed.json() as { result: { tools: Array<{ name: string; _meta: unknown; securitySchemes: unknown }> } };
    assert.deepEqual(data.result.tools.map(t => t.name).sort(), ["batch", "browser", "desktop", "device", "files", "process"]);
    for (const tool of data.result.tools) assert.deepEqual(tool._meta, { securitySchemes: [{ type: "oauth2", scopes: ["tetherplane:access"] }] });
    for (const tool of data.result.tools) assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["tetherplane:access"] }]);
    const expired = await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "device", arguments: { op: "status" } } }, { authorization: "Bearer expired", "mcp-session-id": session });
    const error = await expired.json() as { result: { isError: boolean; _meta: Record<string,string[]> } };
    assert.equal(error.result.isError, true);
    assert.match(error.result._meta["mcp/www_authenticate"]![0]!, /resource_metadata=/);
    assert.match(error.result._meta["mcp/www_authenticate"]![0]!, /error="invalid_token", error_description="Authentication required"/);
  } finally { await relay.close(); }
});
