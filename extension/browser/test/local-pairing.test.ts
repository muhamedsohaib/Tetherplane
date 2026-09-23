import assert from "node:assert/strict";
import test from "node:test";

import { requestLocalPairing } from "../src/local-pairing.ts";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";

test("local pairing posts only extension identity and returns launch config", async () => {
  const calls: Array<{
    input: string;
    init?: RequestInit | undefined;
  }> = [];

  const fetcher = async (
    input: string,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ input, init });
    return new Response(
      JSON.stringify({
        bridge_url: "ws://127.0.0.1:8123",
        launch_token: "opaque-test-token",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  };

  const config = await requestLocalPairing(
    fetcher,
    extensionId,
    "http://127.0.0.1:17656/pair",
  );

  assert.deepEqual(config, {
    bridge_url: "ws://127.0.0.1:8123",
    launch_token: "opaque-test-token",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input, "http://127.0.0.1:17656/pair");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(
    JSON.parse(String(calls[0]?.init?.body)),
    { extension_id: extensionId },
  );
});

test("local pairing rejects non-loopback broker endpoints", async () => {
  await assert.rejects(
    () =>
      requestLocalPairing(
        async () => new Response(),
        extensionId,
        "https://attacker.example/pair",
      ),
    /loopback/,
  );
});

test("local pairing surfaces broker denial without leaking response body", async () => {
  await assert.rejects(
    () =>
      requestLocalPairing(
        async () =>
          new Response("do-not-surface-this-body", {
            status: 403,
          }),
        extensionId,
        "http://127.0.0.1:17656/pair",
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Local Tetherplane pairing was denied",
  );
});
