import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
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

test("RFC 9207: actual authorization code callback iss equals discovery issuer byte-for-byte", async () => {
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

    const originalBegin = service.interactions.beginInteraction.bind(service.interactions);
    service.interactions.beginInteraction = async (...args) => {
      try { return await originalBegin(...args); }
      catch (error) {
        // Synthetic client only: report class/message without request, cookies or tokens.
        console.error("Fixture interaction rejection:", error instanceof Error ? error.name + ": " + error.message : "unknown error");
        throw error;
      }
    };

    const base = service.address.url;
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
        client_name: "Issuer regression fixture (no real identity)",
      }),
    });
    assert.equal(registration.status, 201);
    const client = await registration.json() as Record<string, unknown>;
    assert.equal(typeof client.client_id, "string");

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
    auth.searchParams.set("scope", "openid tetherplane:access");
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
      const diagnostic = (await response.text()).slice(0,400);
      assert.fail("OAuth flow stopped at " + new URL(current, ISSUER).pathname + " (HTTP " + response.status + "); response=" + diagnostic + "; cookie names=" + [...cookies.keys()].join(","));
    }
    assert.fail("Too many authorization redirects; no callback issued");
  } finally {
    await service?.close();
    storage.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
