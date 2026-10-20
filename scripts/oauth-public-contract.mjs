/**
 * Read-only Tetherplane public OAuth contract preflight.
 *
 * Never registers clients, follows redirects, requests tokens, sends device
 * credentials, or modifies a production process. A failure is a NO-GO for
 * a new ChatGPT reconnection until independently investigated.
 *
 * Does not prove that ChatGPT's privately stored expected issuer matches.
 */
import { createPublicKey } from "node:crypto";
import { pathToFileURL } from "node:url";

const ISSUER = "https://vaulter.tailf65eba.ts.net/";
const RESOURCE = "https://vaulter.tailf65eba.ts.net/mcp";
const OPENID_METADATA = ISSUER + ".well-known/openid-configuration";
const RESOURCE_METADATA = ISSUER + ".well-known/oauth-protected-resource/mcp";
const JWKS_URI = ISSUER + "jwks";

function fail(label, cause) {
  throw new Error(label + ": " + cause);
}

function requireExact(actual, expected, label) {
  if (actual !== expected) fail(label, "metadata mismatch");
}

function requireStringList(value, label) {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) {
    fail(label, "invalid metadata list");
  }
  return value;
}

async function readJson(url, label, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    fail(label, "metadata unavailable (network or timeout)");
  }

  if (!response || response.status !== 200) {
    fail(label, "metadata HTTP " + String(response?.status ?? "unavailable"));
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail(label, "invalid JSON metadata");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail(label, "invalid metadata payload");
  }
  return payload;
}

function verifyDiscovery(data) {
  requireExact(data.issuer, ISSUER, "issuer");
  requireExact(data.authorization_endpoint, ISSUER + "auth", "authorization endpoint");
  requireExact(data.token_endpoint, ISSUER + "token", "token endpoint");
  requireExact(data.registration_endpoint, ISSUER + "reg", "registration endpoint");
  requireExact(data.jwks_uri, JWKS_URI, "JWKS endpoint");
  requireExact(data.authorization_response_iss_parameter_supported, true, "authorization response issuer support");

  const methods = requireStringList(data.code_challenge_methods_supported, "PKCE");
  if (methods.length !== 1 || methods[0] !== "S256") {
    fail("PKCE", "expected only S256; do not weaken code challenge verification");
  }

  const scopes = requireStringList(data.scopes_supported, "OIDC scopes");
  if (scopes.includes("tetherplane:access")) {
    fail("OIDC scopes", "MCP permission incorrectly advertised as general OIDC scope");
  }
  if (scopes.length !== 2 || !scopes.includes("openid") || !scopes.includes("offline_access")) {
    fail("OIDC scopes", "general OIDC permissions are missing or expanded");
  }
}

function verifyResource(data) {
  requireExact(data.resource, RESOURCE, "protected resource");
  const servers = requireStringList(data.authorization_servers, "authorization server");
  if (servers.length !== 1 || servers[0] !== ISSUER) {
    fail("authorization server", "issuer list is not the exact expected authority");
  }
  const scopes = requireStringList(data.scopes_supported, "MCP resource scopes");
  if (scopes.length !== 1 || scopes[0] !== "tetherplane:access") {
    fail("MCP resource scopes", "access permissions missing or expanded");
  }
}

function verifyJwks(data) {
  if (!Array.isArray(data.keys) || data.keys.length < 1) {
    fail("JWKS", "no public signing keys");
  }
  const keyIds = new Set();
  const privateFields = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
  for (const key of data.keys) {
    if (!key || typeof key !== "object" || Array.isArray(key) ||
        typeof key.kid !== "string" || key.kid.length < 1 ||
        typeof key.kty !== "string") {
      fail("JWKS", "invalid public key metadata");
    }
    if (key.kty !== "RSA" || key.alg !== "RS256" || key.use !== "sig" ||
        typeof key.n !== "string" || !key.n || typeof key.e !== "string" || !key.e) {
      fail("JWKS", "expected a public RS256 signing key");
    }
    // Reject syntactically shaped but unusable signing keys. Validate only
    // public RSA material; neither load nor publish an auth signing secret.
    let parsedPublicKey;
    try {
      parsedPublicKey = createPublicKey({
        format: "jwk",
        key: { kty: "RSA", n: key.n, e: key.e },
      });
    } catch {
      fail("JWKS", "invalid RSA public JWK");
    }
    if (parsedPublicKey.asymmetricKeyType !== "rsa" ||
        (parsedPublicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        key.e !== "AQAB") {
      fail("JWKS", "unsafe RSA signing key modulus or public exponent");
    }
    if (keyIds.has(key.kid)) {
      fail("JWKS", "duplicate signing key identifier");
    }
    keyIds.add(key.kid);
    if (privateFields.some(field => Object.hasOwn(key, field))) {
      fail("JWKS", "private key material must never be published");
    }
  }
  return data.keys.length;
}

export async function validatePublicOAuthContract({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    fail("OAuth preflight", "fetch implementation unavailable");
  }
  const discovery = await readJson(OPENID_METADATA, "OIDC discovery", fetchImpl);
  verifyDiscovery(discovery);

  const resource = await readJson(RESOURCE_METADATA, "protected resource", fetchImpl);
  verifyResource(resource);

  const jwks = await readJson(JWKS_URI, "JWKS", fetchImpl);
  const publicKeyCount = verifyJwks(jwks);

  return {
    status: "ok",
    issuer: ISSUER,
    resource: RESOURCE,
    publicKeyCount,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validatePublicOAuthContract()
    .then(result => {
      process.stdout.write(
        "PASS: public OAuth issuer, resource, PKCE, access scope, and public JWKS agree.\n" +
        "Issuer: " + result.issuer + "\n" +
        "MCP resource: " + result.resource + "\n" +
        "Public signing keys: " + result.publicKeyCount + "\n",
      );
    })
    .catch(error => {
      // Only errors deliberately constructed above; never log response
      // bodies, browser callback URLs, device identities, tokens or secrets.
      process.stderr.write("NO-GO: " + error.message + "\n");
      process.exitCode = 1;
    });
}
