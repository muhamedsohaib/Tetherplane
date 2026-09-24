import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";

// All signing keys and tokens are ephemeral test data.
test("OIDC validates signed access tokens and binds only explicitly allowed subject/client pairs", async () => {
  const module = await import("../src/auth/oidc-auth.ts");
  assert.equal(typeof module.OidcClientAuthenticator, "function");
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  const options = {
    issuer: "https://identity.example/", audience: "https://relay.example/mcp",
    jwksUri: "https://identity.example/.well-known/jwks.json",
    scopes: ["tetherplane:access"],
    bindings: [{ subject: "owner", clientId: "chatgpt", accountId: "account-a", principalId: "human:owner" }],
  };
  const auth = new module.OidcClientAuthenticator(options, createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] }));
  const base = { iss: options.issuer, aud: options.audience, sub: "owner", azp: "chatgpt", scope: "tetherplane:access", exp: Math.floor(Date.now()/1000)+300 };
  const sign = (claims: Record<string, unknown>, key = keys.privateKey) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(key);
  assert.deepEqual(await auth.authenticate(await sign(base)), { accountId: "account-a", clientId: "chatgpt", principalId: "human:owner" });
  for (const change of [{ iss: "https://evil.example/" }, { aud: "another-api" }, { exp: 1 }, { exp: undefined }, { nbf: base.exp+300 }, { scope: "other" }, { scope: "tetherplane:access-extra" }, { sub: "stranger" }, { azp: "other-client" }, { azp: undefined }]) {
    assert.equal(await auth.authenticate(await sign({ ...base, ...change })), null);
  }
  const other = await generateKeyPair("RS256");
  assert.equal(await auth.authenticate(await sign(base, other.privateKey)), null);
  assert.equal(await auth.authenticate("malformed"), null);
  assert.throws(() => new module.OidcClientAuthenticator({ ...options, issuer: "http://identity.example/" }));
  assert.throws(() => new module.OidcClientAuthenticator({ ...options, scopes: [] }));
  assert.throws(() => new module.OidcClientAuthenticator({ ...options, bindings: [...options.bindings, ...options.bindings] }));
});
