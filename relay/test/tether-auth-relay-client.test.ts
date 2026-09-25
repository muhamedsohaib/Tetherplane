import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  RelayDeviceLoginProofClient,
} from "../../auth/src/relay-device-login.ts";

test("tether-auth relay client starts and consumes login proofs with server-only bridge authentication", async () => {
  const requests: Array<{
    path: string;
    authorization: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk as Uint8Array),
      );
    }
    const body = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as Record<string, unknown>;
    requests.push({
      path: request.url ?? "",
      authorization: request.headers.authorization,
      body,
    });

    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/device-login/start") {
      response.statusCode = 200;
      response.end(
        JSON.stringify({
          userCode: "ABCD-1234",
          expiresAt: "2026-09-25T13:00:00.000Z",
        }),
      );
      return;
    }
    if (request.url === "/auth/device-login/consume") {
      response.statusCode = 200;
      response.end(
        JSON.stringify({ accountId: "account-a" }),
      );
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await listen(server);
  const base = baseUrl(server);

  try {
    const client = new RelayDeviceLoginProofClient({
      relayUrl: base,
      bridgeToken:
        "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      allowInsecureLocalhost: true,
    });

    assert.deepEqual(
      await client.start({
        interactionUid: "interaction_123",
      }),
      {
        userCode: "ABCD-1234",
        expiresAt: "2026-09-25T13:00:00.000Z",
      },
    );
    assert.deepEqual(
      await client.consume({
        interactionUid: "interaction_123",
        userCode: "ABCD-1234",
      }),
      { accountId: "account-a" },
    );

    assert.deepEqual(
      requests.map((request) => ({
        path: request.path,
        authorization: request.authorization,
      })),
      [
        {
          path: "/auth/device-login/start",
          authorization:
            "Bearer TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        },
        {
          path: "/auth/device-login/consume",
          authorization:
            "Bearer TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        },
      ],
    );
  } finally {
    await closeServer(server);
  }
});

test("tether-auth relay client treats unavailable proof as pending and fails closed on unsafe responses", async () => {
  let mode: "missing" | "unsafe" = "missing";
  const server = createServer(async (_request, response) => {
    response.setHeader("content-type", "application/json");
    if (mode === "missing") {
      response.statusCode = 404;
      response.end(
        JSON.stringify({
          error: { code: "not_found" },
        }),
      );
      return;
    }
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        accountId: "account|unsafe",
      }),
    );
  });
  await listen(server);

  try {
    const client = new RelayDeviceLoginProofClient({
      relayUrl: baseUrl(server),
      bridgeToken:
        "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      allowInsecureLocalhost: true,
    });

    assert.equal(
      await client.consume({
        interactionUid: "interaction_456",
        userCode: "EFGH-5678",
      }),
      null,
    );

    mode = "unsafe";
    await assert.rejects(
      client.consume({
        interactionUid: "interaction_456",
        userCode: "EFGH-5678",
      }),
      /account|response/i,
    );
  } finally {
    await closeServer(server);
  }
});

test("tether-auth relay client requires HTTPS outside explicit loopback development", () => {
  assert.throws(
    () =>
      new RelayDeviceLoginProofClient({
        relayUrl: "http://relay.example.com",
        bridgeToken:
          "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      }),
    /HTTPS|loopback/i,
  );

  assert.throws(
    () =>
      new RelayDeviceLoginProofClient({
        relayUrl: "http://127.0.0.1:8788",
        bridgeToken:
          "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      }),
    /HTTPS|insecure/i,
  );
});

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
}

function baseUrl(
  server: ReturnType<typeof createServer>,
): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) =>
      error ? reject(error) : resolve(),
    ),
  );
}
