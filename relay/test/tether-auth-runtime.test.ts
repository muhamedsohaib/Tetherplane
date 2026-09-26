import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";

import {
  createTetherAuthRuntime,
  startTetherAuthService,
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


test("tether-auth service closes cleanly on SIGINT or SIGTERM and unregisters lifecycle handlers", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const keys = await generateKeyPair(
      "RS256",
      { extractable: true },
    );
    const privateJwk = {
      ...(await exportJWK(keys.privateKey)),
      kid: `lifecycle-${signal.toLowerCase()}`,
      alg: "RS256",
      use: "sig",
    };
    const listeners = new Map<
      "SIGINT" | "SIGTERM",
      Set<() => void>
    >([
      ["SIGINT", new Set()],
      ["SIGTERM", new Set()],
    ]);
    const signals = {
      once(
        name: "SIGINT" | "SIGTERM",
        listener: () => void,
      ) {
        listeners.get(name)!.add(listener);
        return this;
      },
      off(
        name: "SIGINT" | "SIGTERM",
        listener: () => void,
      ) {
        listeners.get(name)!.delete(listener);
        return this;
      },
      emit(name: "SIGINT" | "SIGTERM") {
        for (const listener of [
          ...listeners.get(name)!,
        ]) {
          listeners.get(name)!.delete(listener);
          listener();
        }
      },
    };

    const service = await startTetherAuthService(
      {
        issuer: "https://auth.example.com/",
        resource: "https://mcp.example.com/mcp",
        interactionBasePath: "/interaction",
        jwks: { keys: [privateJwk] },
        adapter: TestAdapter,
        logins: {
          async start() {
            return {
              userCode: "ABCD-1234",
              expiresAt:
                "2026-09-26T12:00:00.000Z",
            };
          },
          async consume() {
            return null;
          },
        },
        allowInsecureLocalhost: true,
      },
      {
        host: "127.0.0.1",
        port: 0,
      },
      signals,
    );

    assert.equal(
      listeners.get("SIGINT")!.size,
      1,
    );
    assert.equal(
      listeners.get("SIGTERM")!.size,
      1,
    );

    const health = await fetch(
      `${service.address.url}/healthz`,
    );
    assert.equal(health.status, 200);

    signals.emit(signal);
    await service.closed;

    assert.equal(
      listeners.get("SIGINT")!.size,
      0,
    );
    assert.equal(
      listeners.get("SIGTERM")!.size,
      0,
    );

    await assert.rejects(
      fetch(`${service.address.url}/healthz`),
    );

    await service.close();
  }
});
