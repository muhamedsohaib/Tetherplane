import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";
import { RelayServer } from "../src/server.ts";

const oauth = {
  resource: "https://relay.example/mcp",
  issuer: "https://identity.example/",
  scopes: ["tetherplane:access"],
};

test("relay terminates unmatched routes promptly instead of hanging", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-relay-fallback-"));
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    authenticator: auth(),
    oauth,
    allowInsecureLocalhost: true,
  });

  try {
    const address = await relay.listen({ host: "127.0.0.1", port: 0 });

    const probe = await fetch(`${address.httpUrl}/no-such-path-tp-probe`, {
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(probe.status, 404);
    await probe.text();
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("relay answers authorization-server guesses promptly so clients fall back to discovery", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-relay-authserver-"));
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    authenticator: auth(),
    oauth,
    allowInsecureLocalhost: true,
  });

  try {
    const address = await relay.listen({ host: "127.0.0.1", port: 0 });

    for (const pathname of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
    ]) {
      const response = await fetch(`${address.httpUrl}${pathname}`, {
        signal: AbortSignal.timeout(2_000),
      });
      assert.equal(response.status, 404);
      await response.text();
    }
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function auth(): StaticClientAuthenticator {
  return new StaticClientAuthenticator([
    {
      token: "relay-fallback-test-token",
      accountId: "account-a",
      clientId: "client-a",
      principalId: "human:account-a",
    },
  ]);
}
