import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import {
  TetherAuthServer,
} from "../../auth/src/server.ts";

test("tether-auth server exposes minimal liveness/readiness and delegates OAuth routes", async () => {
  const server = new TetherAuthServer({
    providerHandler(request: IncomingMessage, response: ServerResponse) {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url }));
    },
    allowInsecureLocalhost: true,
  });

  try {
    const address = await server.listen({
      host: "127.0.0.1",
      port: 0,
    });

    const health = await fetch(`${address.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const ready = await fetch(`${address.url}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });

    const delegated = await fetch(
      `${address.url}/.well-known/openid-configuration`,
    );
    assert.equal(delegated.status, 200);
    assert.deepEqual(await delegated.json(), {
      path: "/.well-known/openid-configuration",
    });
  } finally {
    await server.close();
  }
});

test("tether-auth plaintext server is restricted to explicit loopback development", async () => {
  const providerHandler = (
    _request: IncomingMessage,
    response: ServerResponse,
  ) => {
    response.statusCode = 204;
    response.end();
  };

  const nonLoopback = new TetherAuthServer({
    providerHandler,
    allowInsecureLocalhost: true,
  });
  try {
    await assert.rejects(
      nonLoopback.listen({ host: "0.0.0.0", port: 0 }),
      /TLS|loopback/i,
    );
  } finally {
    await nonLoopback.close();
  }

  const strict = new TetherAuthServer({
    providerHandler,
  });
  try {
    await assert.rejects(
      strict.listen({ host: "127.0.0.1", port: 0 }),
      /TLS|insecure/i,
    );
  } finally {
    await strict.close();
  }
});

test("tether-auth health probes never delegate or expose provider state", async () => {
  let delegated = 0;
  const server = new TetherAuthServer({
    providerHandler(_request, response) {
      delegated += 1;
      response.statusCode = 500;
      response.end("sensitive-provider-state");
    },
    allowInsecureLocalhost: true,
  });

  try {
    const address = await server.listen({
      host: "127.0.0.1",
      port: 0,
    });
    for (const path of ["/healthz", "/readyz"]) {
      const response = await fetch(`${address.url}${path}`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(text, /provider|sensitive/i);
    }
    assert.equal(delegated, 0);
  } finally {
    await server.close();
  }
});
