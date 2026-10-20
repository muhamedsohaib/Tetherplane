import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTetherAuthProvider } from "../src/provider.ts";
import { createSqliteAdapter } from "../src/sqlite-adapter.ts";

const ISSUER = "https://issuer.example.test/";
const RESOURCE = "https://relay.example.test/mcp";
const CALLBACK = "https://client.example.test/oauth/callback";

test("RFC 9207 response iss matches the advertised discovery issuer byte-for-byte", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tether-issuer-"));
  const storage = createSqliteAdapter({
    databasePath: path.join(temporary, "issuer.sqlite"),
  });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const provider = createTetherAuthProvider({
    issuer: ISSUER,
    resource: RESOURCE,
    interactionBasePath: "/interaction",
    adapter: storage.Adapter,
    jwks: {
      keys: [{
        ...privateKey.export({ format: "jwk" }),
        kid: "issuer-fixture-only",
        alg: "RS256",
        use: "sig",
      }],
    },
  });
  const server = createServer(provider.callback());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;

    const discovery = await fetch(base + "/.well-known/openid-configuration");
    assert.equal(discovery.status, 200);
    const metadata = await discovery.json() as Record<string, unknown>;
    assert.equal(metadata.issuer, ISSUER);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);

    const registration = await fetch(base + "/reg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_name: "Issuer regression fixture (no external identity)",
      }),
    });
    assert.equal(registration.status, 201);
    const client = await registration.json() as Record<string, unknown>;
    assert.equal(typeof client.client_id, "string");

    // A validated client and redirect_uri with an invalid scope must produce
    // an error callback carrying iss. No login, browser, tokens, or
    // authorization approval takes place in this diagnostic.
    const auth = new URL(base + "/auth");
    auth.searchParams.set("client_id", client.client_id as string);
    auth.searchParams.set("redirect_uri", CALLBACK);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", "openid deliberately-invalid-scope");
    auth.searchParams.set("state", "issuer-fixture-state");
    const verifier = "x".repeat(43);
    auth.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    auth.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(auth, { redirect: "manual" });
    assert.ok(response.status === 302 || response.status === 303,
      "Expected an OAuth redirect, got HTTP " + response.status);
    const location = response.headers.get("location");
    assert.ok(location, "Missing OAuth authorization redirect");
    const callback = new URL(location, ISSUER);
    assert.equal(callback.origin + callback.pathname, CALLBACK);
    assert.equal(callback.searchParams.get("error"), "invalid_scope");
    assert.equal(callback.searchParams.get("state"), "issuer-fixture-state");
    assert.equal(
      callback.searchParams.get("iss"),
      metadata.issuer,
      "RFC 9207 callback issuer must exactly match discovery, including trailing slash",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    storage.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
