import assert from "node:assert/strict";
import test from "node:test";

import { TetherAuthServer } from "../src/server.ts";

function regBody(name: string): string {
  return JSON.stringify({
    redirect_uris: ["http://127.0.0.1:8765/callback"],
    client_name: name,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}

async function postReg(
  base: string,
  name: string,
): Promise<{ status: number; retryAfter: string | null }> {
  const response = await fetch(base + "/reg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: regBody(name),
  });
  await response.text();
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
  };
}

function stubProvider(
  calls: Array<string>,
): (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
) => void {
  return (request, response) => {
    calls.push(
      `${request.method ?? ""} ${request.url ?? ""}`,
    );
    response.writeHead(201, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ client_id: "test-client" }));
  };
}

test("dynamic registration allows requests under the limit", async () => {
  const calls: Array<string> = [];
  const server = new TetherAuthServer({
    providerHandler: stubProvider(calls),
    allowInsecureLocalhost: true,
    dcrRateLimit: { maxRequests: 3, windowMs: 60_000 },
  });
  try {
    const address = await server.listen({
      host: "127.0.0.1",
      port: 0,
    });
    for (let i = 0; i < 3; i += 1) {
      const result = await postReg(
        address.url,
        `allowed-${i}`,
      );
      assert.equal(result.status, 201);
    }
    assert.equal(calls.length, 3);
  } finally {
    await server.close();
  }
});

test("dynamic registration throttles requests over the limit without reaching the provider", async () => {
  const calls: Array<string> = [];
  const server = new TetherAuthServer({
    providerHandler: stubProvider(calls),
    allowInsecureLocalhost: true,
    dcrRateLimit: { maxRequests: 2, windowMs: 60_000 },
  });
  try {
    const address = await server.listen({
      host: "127.0.0.1",
      port: 0,
    });
    assert.equal(
      (await postReg(address.url, "first")).status,
      201,
    );
    assert.equal(
      (await postReg(address.url, "second")).status,
      201,
    );
    const throttled = await postReg(
      address.url,
      "third",
    );
    assert.equal(throttled.status, 429);
    assert.ok(
      throttled.retryAfter !== null &&
        Number(throttled.retryAfter) > 0,
      "throttled registration must advertise retry-after",
    );
    assert.equal(calls.length, 2);
  } finally {
    await server.close();
  }
});

test("dynamic registration recovers after the window and leaves authenticated management alone", async () => {
  const calls: Array<string> = [];
  const server = new TetherAuthServer({
    providerHandler: stubProvider(calls),
    allowInsecureLocalhost: true,
    dcrRateLimit: { maxRequests: 1, windowMs: 150 },
  });
  try {
    const address = await server.listen({
      host: "127.0.0.1",
      port: 0,
    });
    assert.equal(
      (await postReg(address.url, "one")).status,
      201,
    );
    assert.equal(
      (await postReg(address.url, "two")).status,
      429,
    );
    // Authenticated registration management must never be throttled.
    const managed = await fetch(address.url + "/reg/some-client", {
      headers: { authorization: "Bearer test-token" },
    });
    await managed.text();
    assert.equal(managed.status, 201);
    await new Promise((resolve) =>
      setTimeout(resolve, 250),
    );
    assert.equal(
      (await postReg(address.url, "three")).status,
      201,
    );
  } finally {
    await server.close();
  }
});

test("dynamic registration rejects invalid rate limit configuration", () => {
  assert.throws(
    () =>
      new TetherAuthServer({
        providerHandler: stubProvider([]),
        allowInsecureLocalhost: true,
        dcrRateLimit: { maxRequests: 0, windowMs: 60_000 },
      }),
    /rate limit/i,
  );
  assert.throws(
    () =>
      new TetherAuthServer({
        providerHandler: stubProvider([]),
        allowInsecureLocalhost: true,
        dcrRateLimit: { maxRequests: 5, windowMs: 0 },
      }),
    /rate limit/i,
  );
});
