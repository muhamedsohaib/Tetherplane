import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";

import {
  createTetherAuthRuntime,
} from "../../auth/src/runtime.ts";

test("tether-auth runtime composes the real provider interaction controller and hardened server", async () => {
  const keys = await generateKeyPair(
    "RS256",
    { extractable: true },
  );
  const privateJwk = {
    ...(await exportJWK(keys.privateKey)),
    kid: "runtime-smoke",
    alg: "RS256",
    use: "sig",
  };
  const starts: string[] = [];

  const runtime = createTetherAuthRuntime({
    issuer: "https://auth.example.com/",
    resource: "https://mcp.example.com/mcp",
    interactionBasePath: "/interaction",
    jwks: { keys: [privateJwk] },
    adapter: TestAdapter,
    logins: {
      async start(input) {
        starts.push(input.interactionUid);
        return {
          userCode: "ABCD-1234",
          expiresAt:
            "2026-09-25T23:00:00.000Z",
        };
      },
      async consume() {
        return null;
      },
    },
    allowInsecureLocalhost: true,
  });

  assert.equal(
    typeof runtime.interactions.beginInteraction,
    "function",
  );
  assert.equal(
    typeof runtime.interactions.completeConsent,
    "function",
  );

  try {
    const address = await runtime.server.listen({
      host: "127.0.0.1",
      port: 0,
    });

    const health = await fetch(
      `${address.url}/healthz`,
    );
    assert.equal(health.status, 200);
    assert.deepEqual(
      await health.json(),
      { status: "ok" },
    );

    const discovery = await fetch(
      `${address.url}/.well-known/openid-configuration`,
    );
    assert.equal(discovery.status, 200);
    const metadata =
      await discovery.json() as Record<string, unknown>;
    assert.equal(
      metadata.issuer,
      "https://auth.example.com/",
    );
    assert.deepEqual(
      metadata.code_challenge_methods_supported,
      ["S256"],
    );
    assert.match(
      String(metadata.registration_endpoint ?? ""),
      /\/reg$/,
    );

    assert.deepEqual(starts, []);
  } finally {
    await runtime.server.close();
  }
});

class TestAdapter {
  constructor(_name: string) {}
  async upsert(): Promise<void> {}
  async find(): Promise<undefined> {
    return undefined;
  }
  async findByUserCode(): Promise<undefined> {
    return undefined;
  }
  async findByUid(): Promise<undefined> {
    return undefined;
  }
  async destroy(): Promise<void> {}
  async revokeByGrantId(): Promise<void> {}
  async consume(): Promise<void> {}
}
