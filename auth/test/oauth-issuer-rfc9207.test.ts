import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startTetherAuthService } from "../src/runtime.ts";
import { createSqliteAdapter } from "../src/sqlite-adapter.ts";

const ISSUER = "https://issuer.example.test/";
const RESOURCE = "https://relay.example.test/mcp";
const CALLBACK = "https://client.example.test/oauth/callback";
const USER_CODE = "ABCD-1234";

test("provider normalizes an HTTPS issuer origin exactly once before discovery", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tether-issuer-no-slash-"));
  const storage = createSqliteAdapter({ databasePath: path.join(tmp, "issuer.sqlite") });
  const {privateKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
  let service: Awaited<ReturnType<typeof startTetherAuthService>> | undefined;
  try {
    service = await startTetherAuthService({
      issuer: ISSUER.slice(0, -1),
      resource: RESOURCE,
      interactionBasePath: "/interaction",
      adapter: storage.Adapter,
      jwks: {keys: [{...privateKey.export({format: "jwk"}), kid:"no-slash-fixture", alg:"RS256", use:"sig"}]},
      allowInsecureLocalhost: true,
      logins: {
        async start() { return {userCode: USER_CODE, expiresAt: new Date(Date.now()+300000).toISOString()}; },
        async consume() { return {accountId: "fixture"}; },
      },
    }, {host:"127.0.0.1", port:0});
    const response = await fetch(service.address.url+"/.well-known/openid-configuration");
    assert.equal(response.status, 200);
    const metadata = await response.json() as {issuer:string};
    assert.equal(metadata.issuer, ISSUER, "Provider must not publish an unnormalized no-slash issuer");
  } finally {
    await service?.close();
    storage.close();
    await rm(tmp, {recursive:true, force:true});
  }
});

for (const requestedScope of ["openid tetherplane:access", "tetherplane:access"]) {
  test("RFC 9207 callback and resource-scoped JWT for: " + requestedScope, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tether-issuer-"));
  const storage = createSqliteAdapter({
    databasePath: path.join(temporary, "issuer.sqlite"),
  });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = {
    keys: [{
      ...privateKey.export({ format: "jwk" }),
      kid: "issuer-fixture-only",
      alg: "RS256",
      use: "sig",
    }],
  };
  let service: Awaited<ReturnType<typeof startTetherAuthService>> | undefined;
  try {
    service = await startTetherAuthService({
      issuer: ISSUER,
      resource: RESOURCE,
      interactionBasePath: "/interaction",
      adapter: storage.Adapter,
      jwks,
      allowInsecureLocalhost: true,
      logins: {
        async start() {
          return { userCode: USER_CODE, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
        },
        async consume() {
          return { accountId: "account-fixture" };
        },
      },
    }, { host: "127.0.0.1", port: 0 });

    const base = service.address.url;
    const discovery = await fetch(base + "/.well-known/openid-configuration");
    assert.equal(discovery.status, 200);
    const metadata = await discovery.json() as Record<string, unknown>;
    assert.equal(metadata.issuer, ISSUER);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
    assert.equal(
      (metadata.scopes_supported as string[]).includes("tetherplane:access"),
      false,
      "MCP resource permissions must not be advertised as generic OIDC scopes",
    );

    const registration = await fetch(base + "/reg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        client_name: "Issuer regression fixture (no real identity)",
      }),
    });
    assert.equal(registration.status, 201);
    const client = await registration.json() as Record<string, unknown>;
    assert.equal(typeof client.client_id, "string");

    // RFC 9207 also requires iss on error responses. A prompt=none request
    // cannot log in the synthetic account and must fail through the normal
    // client callback, never with a missing or altered issuer.
    const silent = new URL("/auth", ISSUER);
    silent.searchParams.set("client_id", client.client_id as string);
    silent.searchParams.set("redirect_uri", CALLBACK);
    silent.searchParams.set("response_type", "code");
    silent.searchParams.set("scope", "openid");
    silent.searchParams.set("prompt", "none");
    silent.searchParams.set("state", "issuer-fixture-error-state");
    silent.searchParams.set("code_challenge", createHash("sha256").update("x".repeat(43)).digest("base64url"));
    silent.searchParams.set("code_challenge_method", "S256");
    const silentResponse = await fetch(base + silent.pathname + silent.search, { redirect: "manual" });
    assert.ok(silentResponse.status >= 300 && silentResponse.status < 400);
    const silentLocation = silentResponse.headers.get("location");
    assert.ok(silentLocation, "Silent authorization errors must redirect to the registered client");
    const silentCallback = new URL(silentLocation, ISSUER);
    assert.equal(silentCallback.origin + silentCallback.pathname, CALLBACK);
    assert.match(String(silentCallback.searchParams.get("error")), /required|denied/);
    assert.equal(silentCallback.searchParams.get("state"), "issuer-fixture-error-state");
    assert.equal(
      silentCallback.searchParams.get("iss"),
      metadata.issuer,
      "RFC 9207 requires byte-identical iss in error responses too",
    );

    // The entire flow stays on a loopback ephemeral service, except the final
    // Location value. Never follow the callback to the synthetic external host.
    const cookies = new Map<string, string>();
    const request = async (pathAndSearch: string, body?: Record<string, unknown>) => {
      const headers = new Headers();
      if (cookies.size) {
        headers.set("cookie", [...cookies].map(([key, value]) => key + "=" + value).join("; "));
      }
      if (body) headers.set("content-type", "application/json");
      const response = await fetch(base + pathAndSearch, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      for (const line of response.headers.getSetCookie()) {
        const entry = line.split(";", 1)[0] ?? "";
        const equal = entry.indexOf("=");
        if (equal > 0) cookies.set(entry.slice(0, equal), entry.slice(equal + 1));
      }
      return response;
    };

    const verifier = "x".repeat(43);
    const auth = new URL("/auth", ISSUER);
    auth.searchParams.set("client_id", client.client_id as string);
    auth.searchParams.set("redirect_uri", CALLBACK);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", requestedScope);
    auth.searchParams.set("resource", RESOURCE);
    auth.searchParams.set("state", "issuer-fixture-state");
    auth.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    auth.searchParams.set("code_challenge_method", "S256");

    let current = auth.pathname + auth.search;
    let body: Record<string, unknown> | undefined;
    for (let step = 0; step < 16; step++) {
      const response = await request(current, body);
      body = undefined;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        assert.ok(location, "OAuth redirect must provide Location");
        const next = new URL(location, ISSUER);
        if (next.origin === new URL(CALLBACK).origin) {
          assert.equal(next.origin + next.pathname, CALLBACK);
          assert.equal(next.searchParams.get("state"), "issuer-fixture-state");
          assert.ok(next.searchParams.get("code"), "Callback has authorization code");
          assert.equal(
            next.searchParams.get("iss"),
            metadata.issuer,
            "RFC9207 issuer must match discovery exactly, including trailing slash",
          );

          // Redeem only the synthetic PKCE authorization code against the
          // local fixture. A valid code must not produce an access token for
          // any other audience, and the access permission remains resource-bound.
          const tokenResponse = await fetch(base + "/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: next.searchParams.get("code")!,
              client_id: client.client_id as string,
              redirect_uri: CALLBACK,
              code_verifier: verifier,
              resource: RESOURCE,
            }),
            redirect: "manual",
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(tokenResponse.status, 200, "Canonical resource token exchange must succeed");
          const tokens = await tokenResponse.json() as Record<string, unknown>;
          assert.equal(typeof tokens.access_token, "string");
          const jwt = (tokens.access_token as string).split(".");
          assert.equal(jwt.length, 3, "Resource access token must be a signed JWT");
          const claims = JSON.parse(Buffer.from(jwt[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
          assert.equal(claims.iss, ISSUER);
          assert.deepEqual(claims.aud, RESOURCE);
          assert.equal(claims.scope, "tetherplane:access", "No standalone or additional resource permissions");
          assert.equal(
            verify(
              "RSA-SHA256",
              Buffer.from(jwt[0] + "." + jwt[1]),
              createPublicKey(privateKey),
              Buffer.from(jwt[2]!, "base64url"),
            ),
            true,
            "Synthetic JWT signature must verify against the configured key",
          );
          return;
        }
        assert.ok(
          next.origin === new URL(ISSUER).origin || next.origin === new URL(base).origin,
          "Unexpected authorization redirect origin",
        );
        current = next.pathname + next.search;
        continue;
      }
      if (response.status === 200 && current.startsWith("/interaction/")) {
        const status = await response.json() as {status?: string};
        const pathname = new URL(current, ISSUER).pathname;
        if (status.status === "pending_device_approval") {
          current = pathname + "/device-login";
          body = { userCode: USER_CODE };
          continue;
        }
        if (status.status === "awaiting_consent") {
          current = pathname + "/consent";
          body = {};
          continue;
        }
        assert.fail("Unexpected interaction status: " + String(status.status));
      }
      assert.fail("Synthetic OAuth flow stopped at " + new URL(current, ISSUER).pathname + " (HTTP " + response.status + ")");
    }
    assert.fail("Too many authorization redirects; no callback issued");
  } finally {
    await service?.close();
    storage.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
}
