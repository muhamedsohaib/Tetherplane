import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  StaticClientAuthenticator,
} from "../src/auth/static-auth.ts";
import { RelayServer } from "../src/server.ts";

test("relay server permits explicit plaintext loopback development mode", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "tether-relay-server-"),
  );
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    authenticator: auth(),
    allowInsecureLocalhost: true,
  });

  try {
    const address = await relay.listen({
      host: "127.0.0.1",
      port: 0,
    });
    assert.match(address.httpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(address.deviceWsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/device$/);
    assert.equal(relay.isSecure, false);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("plaintext relay refuses production or non-loopback binding", async () => {
  const relay = await RelayServer.create({
    authenticator: auth(),
    allowInsecureLocalhost: true,
  });

  try {
    await assert.rejects(
      relay.listen({ host: "0.0.0.0", port: 0 }),
      /TLS|loopback/i,
    );
  } finally {
    await relay.close();
  }

  const strictRelay = await RelayServer.create({
    authenticator: auth(),
  });
  try {
    await assert.rejects(
      strictRelay.listen({ host: "127.0.0.1", port: 0 }),
      /TLS|insecure/i,
    );
  } finally {
    await strictRelay.close();
  }
});

function auth(): StaticClientAuthenticator {
  return new StaticClientAuthenticator([
    {
      token: "relay-server-test-token",
      accountId: "account-a",
      clientId: "client-a",
      principalId: "human:account-a",
    },
  ]);
}
