import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTetherAuthProvider } from "../src/provider.ts";
import { TetherAuthServer } from "../src/server.ts";
import { createSqliteAdapter } from "../src/sqlite-adapter.ts";

test("abandoned interaction forms have bounded capacity and expired proofs release it", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const server = new TetherAuthServer({
    allowInsecureLocalhost: true,
    providerHandler(_request, response) { response.writeHead(404).end(); },
    interactions: {
      async beginLogin() {
        return { userCode: "ABCD-1234", expiresAt: new Date(now + 300_000).toISOString() };
      },
      async completeLogin() { return "pending" as const; },
    },
  });
  try {
    const { url } = await server.listen({ host: "127.0.0.1", port: 0 });
    const open = (uid: string) => fetch(url + "/interaction/" + uid,
      { headers: { accept: "text/html" } });
    let firstToken = "";
    for (let i = 0; i < 1024; i += 1) {
      const response = await open("interaction_" + i);
      assert.equal(response.status, 200);
      const html = await response.text();
      if (i === 0) firstToken = /name="csrf" value="([a-f0-9]{64})"/.exec(html)?.[1] ?? "";
    }
    const full = await open("interaction_overflow");
    assert.equal(full.status, 503, "new form proofs must not grow without a bound");
    assert.ok(Number(full.headers.get("retry-after")) > 0);
    await full.text();

    const submitted = await fetch(url + "/interaction/interaction_0/device-login", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ userCode: "ABCD-1234", csrf: firstToken }),
    });
    assert.equal(submitted.status, 202, "capacity must preserve existing users' proofs");
    await submitted.text();
    const refreshed = await open("interaction_0");
    assert.equal(refreshed.status, 200, "an existing UID can refresh at capacity");
    await refreshed.text();

    now += 300_001;
    const recovered = await open("interaction_after_expiry");
    assert.equal(recovered.status, 200, "expired abandoned proofs must release capacity");
    await recovered.text();
  } finally {
    await server.close();
  }
});

test("real OIDC registration aliases share the canonical registration budget", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tether-auth-registration-alias-"));
  const sqlite = createSqliteAdapter({ databasePath: path.join(temp, "provider.sqlite") });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const provider = createTetherAuthProvider({
    issuer: "https://auth.example.com/", resource: "https://relay.example.com/mcp",
    interactionBasePath: "/interaction", adapter: sqlite.Adapter,
    jwks: { keys: [{ ...privateKey.export({ format: "jwk" }), kid: "alias-test", alg: "RS256", use: "sig" }] },
  });
  provider.proxy = true;
  try {
    for (const alias of ["/REG", "/reg/", "/ReG/"]) {
      const server = new TetherAuthServer({
        providerHandler: provider.callback(), allowInsecureLocalhost: true,
        dcrRateLimit: { maxRequests: 1, windowMs: 60_000 },
      });
      try {
        const { url } = await server.listen({ host: "127.0.0.1", port: 0 });
        const register = (route: string) => fetch(url + route, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            redirect_uris: ["http://127.0.0.1:8765/callback"],
            token_endpoint_auth_method: "none", grant_types: ["authorization_code"],
            response_types: ["code"],
          }),
        });
        const first = await register(alias);
        assert.equal(first.status, 201, "the real provider must recognize " + alias);
        await first.text();
        for (const route of ["/reg", alias]) {
          const denied = await register(route);
          assert.equal(denied.status, 429, alias + " must consume the shared registration budget");
          assert.ok(Number(denied.headers.get("retry-after")) > 0);
          await denied.text();
        }
      } finally {
        await server.close();
      }
    }
  } finally {
    sqlite.close();
    await rm(temp, { recursive: true, force: true });
  }
});
