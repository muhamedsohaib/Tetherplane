import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";

import { createTetherAuthProvider } from "../../auth/src/provider.ts";

test("tether-auth real provider advertises OAuth code flow, S256, DCR and revocation", async () => {
  const keys = await generateKeyPair("RS256");
  const privateJwk = {
    ...(await exportJWK(keys.privateKey)),
    kid: "auth-smoke",
    alg: "RS256",
    use: "sig",
  };

  const provider = createTetherAuthProvider({
    issuer: "https://auth.example.com/",
    resource: "https://mcp.example.com/mcp",
    interactionBasePath: "/interaction",
    jwks: { keys: [privateJwk] },
    adapter: TestAdapter,
  });

  const metadata = provider.configuration();

  assert.equal(metadata.issuer, "https://auth.example.com/");
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.match(metadata.registration_endpoint ?? "", /\/reg$/);
  assert.match(metadata.revocation_endpoint ?? "", /\/token\/revocation$/);
  assert.ok(metadata.grant_types_supported?.includes("authorization_code"));
  assert.ok(metadata.grant_types_supported?.includes("refresh_token"));
  assert.ok(!metadata.grant_types_supported?.includes("password"));
});

test("tether-auth provider requires explicit signing keys and persistent adapter", () => {
  assert.throws(
    () =>
      createTetherAuthProvider({
        issuer: "https://auth.example.com/",
        resource: "https://mcp.example.com/mcp",
        interactionBasePath: "/interaction",
        jwks: { keys: [] },
        adapter: TestAdapter,
      }),
    /signing|jwks|key/i,
  );

  assert.throws(
    () =>
      createTetherAuthProvider({
        issuer: "https://auth.example.com/",
        resource: "https://mcp.example.com/mcp",
        interactionBasePath: "/interaction",
        jwks: { keys: [{ kty: "RSA", kid: "x" }] },
        adapter: undefined as never,
      }),
    /adapter|persistent/i,
  );
});

class TestAdapter {
  constructor(_name: string) {}
  async upsert(): Promise<void> {}
  async find(): Promise<undefined> { return undefined; }
  async findByUserCode(): Promise<undefined> { return undefined; }
  async findByUid(): Promise<undefined> { return undefined; }
  async destroy(): Promise<void> {}
  async revokeByGrantId(): Promise<void> {}
  async consume(): Promise<void> {}
}
