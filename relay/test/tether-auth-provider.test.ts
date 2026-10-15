import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";

import { createTetherAuthProvider } from "../../auth/src/provider.ts";

test("tether-auth real provider advertises OAuth code flow, S256, DCR and revocation", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
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

  const server = createServer(provider.callback());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/.well-known/openid-configuration`,
    );
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as Record<string, unknown>;

    assert.equal(metadata.issuer, "https://auth.example.com/");
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.match(String(metadata.registration_endpoint ?? ""), /\/reg$/);
    assert.match(
      String(metadata.revocation_endpoint ?? ""),
      /\/token\/revocation$/,
    );
    const grants = metadata.grant_types_supported as string[] | undefined;
    assert.ok(grants?.includes("authorization_code"));
    assert.ok(grants?.includes("refresh_token"));
    assert.ok(!grants?.includes("password"));
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
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

test("tether-auth advertises HTTPS endpoints behind a loopback TLS terminator", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateJwk = {
    ...(await exportJWK(keys.privateKey)),
    kid: "proxy-smoke",
    alg: "RS256",
    use: "sig",
  };

  const { createTetherAuthRuntime } = await import(
    "../../auth/src/runtime.ts"
  );
  const runtime = createTetherAuthRuntime({
    issuer: "https://auth.example.com/",
    resource: "https://mcp.example.com/mcp",
    interactionBasePath: "/interaction",
    jwks: { keys: [privateJwk] },
    adapter: TestAdapter,
    logins: {
      start: async () => ({
        userCode: "ABCD-1234",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      consume: async () => null,
    },
    allowInsecureLocalhost: true,
  });

  const address = await runtime.server.listen({
    host: "127.0.0.1",
    port: 0,
  });
  try {
    const response = await fetch(
      `${address.url}/.well-known/openid-configuration`,
      {
        headers: {
          host: "auth.example.com",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "auth.example.com",
        },
      },
    );
    assert.equal(response.status, 200);
    const metadata = (await response.json()) as Record<string, unknown>;
    for (const field of [
      "authorization_endpoint",
      "token_endpoint",
      "userinfo_endpoint",
      "jwks_uri",
      "registration_endpoint",
      "revocation_endpoint",
    ]) {
      assert.match(
        String(metadata[field] ?? ""),
        /^https:\/\//,
        `${field} must advertise HTTPS behind the TLS terminator`,
      );
    }
  } finally {
    await runtime.server.close();
  }
});

test("tether-auth never trusts forwarded headers in direct TLS mode", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateJwk = {
    ...(await exportJWK(keys.privateKey)),
    kid: "proxy-negative",
    alg: "RS256",
    use: "sig",
  };

  const { createTetherAuthRuntime } = await import(
    "../../auth/src/runtime.ts"
  );
  const runtime = createTetherAuthRuntime({
    issuer: "https://auth.example.com/",
    resource: "https://mcp.example.com/mcp",
    interactionBasePath: "/interaction",
    jwks: { keys: [privateJwk] },
    adapter: TestAdapter,
    logins: {
      start: async () => ({
        userCode: "ABCD-1234",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      consume: async () => null,
    },
    tls: { cert: "test-cert", key: "test-key" },
  });

  try {
    assert.equal(
      (runtime.provider as unknown as { proxy: unknown }).proxy,
      false,
    );
  } finally {
    await runtime.server.close();
  }
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
