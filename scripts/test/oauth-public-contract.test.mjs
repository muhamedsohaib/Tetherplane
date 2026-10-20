import assert from "node:assert/strict";
import test from "node:test";
import { validatePublicOAuthContract } from "../oauth-public-contract.mjs";

const ISSUER = "https://vaulter.tailf65eba.ts.net/";
const RESOURCE = "https://vaulter.tailf65eba.ts.net/mcp";
const routes = {
  discovery: ISSUER + ".well-known/openid-configuration",
  resource: ISSUER + ".well-known/oauth-protected-resource/mcp",
  jwks: ISSUER + "jwks",
};

function validFixture() {
  return {
    [routes.discovery]: {
      issuer: ISSUER,
      authorization_endpoint: ISSUER + "auth",
      token_endpoint: ISSUER + "token",
      registration_endpoint: ISSUER + "reg",
      jwks_uri: routes.jwks,
      authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["openid", "offline_access"],
    },
    [routes.resource]: {
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ["tetherplane:access"],
    },
    [routes.jwks]: {
      keys: [{ kty: "RSA", use: "sig", alg: "RS256", kid: "fixture-only-public", n: "abc", e: "AQAB" }],
    },
  };
}

function fixtureFetch(metadata, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (options.fail === url) throw new Error("synthetic connection refused");
    const body = metadata[url];
    return {
      status: options.status?.[url] ?? (body ? 200 : 404),
      json: async () => body,
    };
  };
  return { fetchImpl, calls };
}

test("accepts exact issuer, resource, public JWKS, and resource-only MCP scope with GET requests", async () => {
  const { fetchImpl, calls } = fixtureFetch(validFixture());
  assert.deepEqual(
    await validatePublicOAuthContract({ fetchImpl }),
    { status: "ok", issuer: ISSUER, resource: RESOURCE, publicKeyCount: 1 },
  );
  assert.deepEqual(calls.map(c => c.url), [routes.discovery, routes.resource, routes.jwks]);
  for (const call of calls) {
    assert.equal(call.init.method, "GET", "Never POST, register clients or request tokens");
    assert.equal(call.init.redirect, "manual", "Never follow a discovery redirect to another origin");
    assert.equal(call.init.body, undefined);
    assert.equal(call.init.headers?.Authorization, undefined);
    assert.equal(call.init.headers?.authorization, undefined);
  }
});

test("fails closed when issuer or advertised resource authority changes by one character", async () => {
  for (const newIssuer of [
    ISSUER.slice(0, -1),
    "https://vaulter.tailf65eba.ts.net:10000/",
    "https://attacker.example.test/",
    "http://vaulter.tailf65eba.ts.net/",
  ]) {
    const data = validFixture();
    data[routes.discovery].issuer = newIssuer;
    await assert.rejects(
      validatePublicOAuthContract({ fetchImpl: fixtureFetch(data).fetchImpl }),
      /issuer/i,
      "Must reject " + newIssuer,
    );
  }
  const m = validFixture();
  m[routes.resource].authorization_servers = [ISSUER.slice(0, -1)];
  await assert.rejects(
    validatePublicOAuthContract({ fetchImpl: fixtureFetch(m).fetchImpl }),
    /authorization server|issuer/i,
  );
});

test("rejects resource substitution and unexpected authorization servers", async () => {
  const wrongResource = validFixture();
  wrongResource[routes.resource].resource = ISSUER + "mcp-alt";
  await assert.rejects(
    validatePublicOAuthContract({ fetchImpl: fixtureFetch(wrongResource).fetchImpl }),
    /resource/i,
  );
  const extra = validFixture();
  extra[routes.resource].authorization_servers.push("https://attacker.example.test/");
  await assert.rejects(
    validatePublicOAuthContract({ fetchImpl: fixtureFetch(extra).fetchImpl }),
    /authorization server/i,
  );
});

test("detects the original duplicate scope regression before another ChatGPT reconnection", async () => {
  const data = validFixture();
  data[routes.discovery].scopes_supported.push("tetherplane:access");
  await assert.rejects(
    validatePublicOAuthContract({ fetchImpl: fixtureFetch(data).fetchImpl }),
    /OIDC|scope/i,
  );
});

test("rejects any general OIDC scope expansion or removal", async () => {
  for (const generalScopes of [
    ["openid", "offline_access", "admin"],
    ["openid"],
    ["offline_access"],
    ["openid", "offline_access", "profile"],
  ]) {
    const data = validFixture();
    data[routes.discovery].scopes_supported = generalScopes;
    await assert.rejects(
      validatePublicOAuthContract({ fetchImpl: fixtureFetch(data).fetchImpl }),
      /OIDC|scope/i,
      "Unexpected generic scope set: " + generalScopes.join(","),
    );
  }
});

test("requires asymmetric RS256 signing keys, never unsigned or symmetric key algorithms", async () => {
  for (const mutation of [
    { kty: "oct" },
    { alg: "none" },
    { use: "enc" },
    { n: "" },
    { e: "" },
  ]) {
    const data = validFixture();
    Object.assign(data[routes.jwks].keys[0], mutation);
    await assert.rejects(
      validatePublicOAuthContract({ fetchImpl: fixtureFetch(data).fetchImpl }),
      /JWKS|key|signature|algorithm/i,
    );
  }
});

test("rejects resource permission loss or expansion", async () => {
  for (const scopes of [[], ["openid"], ["tetherplane:access", "admin"]]) {
    const data = validFixture();
    data[routes.resource].scopes_supported = scopes;
    await assert.rejects(
      validatePublicOAuthContract({ fetchImpl: fixtureFetch(data).fetchImpl }),
      /scope/i,
    );
  }
});

test("requires exact authorization endpoints, PKCE S256 and authorization response issuer support", async () => {
  const scenarios = [
    ["authorization_endpoint", "https://attacker.test/auth"],
    ["token_endpoint", "https://attacker.test/token"],
    ["registration_endpoint", "https://attacker.test/reg"],
    ["jwks_uri", "https://attacker.test/jwks"],
    ["authorization_response_iss_parameter_supported", false],
    ["code_challenge_methods_supported", ["plain"]],
  ];
  for (const [key, value] of scenarios) {
    const data = validFixture();
    data[routes.discovery][key] = value;
    await assert.rejects(
      validatePublicOAuthContract({ fetchImpl: fixtureFetch(data).fetchImpl }),
      /metadata|endpoint|PKCE|issuer|JWKS|S256/i,
      String(key),
    );
  }
});

test("detects missing public signing keys, leaked private key material and duplicate key IDs", async () => {
  const empty = validFixture();
  empty[routes.jwks].keys = [];
  await assert.rejects(validatePublicOAuthContract({ fetchImpl: fixtureFetch(empty).fetchImpl }), /JWKS|key/i);
  const privateKey = validFixture();
  privateKey[routes.jwks].keys[0].d = "private-exposure";
  await assert.rejects(validatePublicOAuthContract({ fetchImpl: fixtureFetch(privateKey).fetchImpl }), /JWKS|private|key/i);
  const duplicate = validFixture();
  duplicate[routes.jwks].keys.push({ ...duplicate[routes.jwks].keys[0] });
  await assert.rejects(validatePublicOAuthContract({ fetchImpl: fixtureFetch(duplicate).fetchImpl }), /JWKS|duplicate|key/i);
});

test("rejects redirects, non-200 responses and missing JSON rather than silently falling back", async () => {
  for (const url of Object.values(routes)) {
    for (const status of [301, 302, 401, 404, 500]) {
      await assert.rejects(
        validatePublicOAuthContract({ fetchImpl: fixtureFetch(validFixture(), { status: { [url]: status } }).fetchImpl }),
        /HTTP|metadata|unavailable/i,
      );
    }
    await assert.rejects(
      validatePublicOAuthContract({ fetchImpl: fixtureFetch(validFixture(), { fail: url }).fetchImpl }),
      /unavailable|failed|network/i,
    );
  }
});

test("malformed JSON and invalid payload shape are errors, never healthy results", async () => {
  for (const url of Object.values(routes)) {
    const data = validFixture();
    data[url] = null;
    await assert.rejects(
      validatePublicOAuthContract({ fetchImpl: fixtureFetch(data).fetchImpl }),
      /invalid|HTTP|metadata|JWKS/i,
    );
  }
});
