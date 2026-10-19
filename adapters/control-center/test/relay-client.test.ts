import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { RelayClient } from "../src/relay-client.ts";

test("relay configuration rejects plaintext remote, credentials and non-origin URLs", () => {
  for (const value of [
    "http://example.com",
    "http://localhost:8788",
    "https://user:pass@example.com",
    "https://example.com/mcp",
    "https://example.com?token=x",
    "https://example.com/#x",
    "file:///tmp/test",
  ]) {
    assert.throws(() => new RelayClient(value));
  }
  assert.doesNotThrow(() => new RelayClient("https://relay.example"));
  assert.doesNotThrow(() => new RelayClient("http://127.0.0.1:8788"));
});

test("relay errors, redirects, oversized and malformed data are bounded and sanitized", async (t) => {
  let mode = "valid";
  let redirected = false;
  const server = createServer((req, res) => {
    if (req.url === "/stolen") redirected = true;
    res.setHeader("content-type", "application/json");
    if (mode === "redirect") {
      res.writeHead(302, { location: "/stolen" });
      res.end();
    } else if (mode === "denied") {
      res.writeHead(401);
      res.end('{"secret":"never-expose-this"}');
    } else if (mode === "large") res.end("x".repeat(300_000));
    else if (mode === "malformed") res.end('{"devices":[{"deviceId":"x"}]}');
    else if (mode === "invalid-json") res.end("not-json never-expose-this");
    else
      res.end(
        JSON.stringify({
          devices: [
            {
              deviceId: "fixture",
              accountId: "a",
              pairedAt: "2026-10-19T00:00:00.000Z",
              revokedAt: null,
              credentialHash: "never-expose-this",
              online: true,
              ...(mode === "transport-active" ? { relayConnected: true } :
                mode === "transport-inactive" ? { relayConnected: false } :
                mode === "transport-malformed" ? { relayConnected: "yes" } : {}),
            },
          ],
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new RelayClient(`http://127.0.0.1:${address.port}`);
  const devices = await client.directory("synthetic-credential");
  assert.deepEqual(devices, [
    {
      deviceId: "fixture",
      pairedAt: "2026-10-19T00:00:00.000Z",
      revokedAt: null,
      connectivity: "not_reported",
      version: null,
    },
  ]);
  for (const [modeValue, expected] of [
    ["transport-active", "relay_connected"],
    ["transport-inactive", "relay_disconnected"],
  ] as const) {
    mode = modeValue;
    const [device] = await client.directory("synthetic-credential");
    assert.equal(device?.connectivity, expected);
    assert.equal(device?.version, null);
  }
  mode = "transport-malformed";
  await assert.rejects(client.directory("synthetic-credential"), {
    code: "invalid_relay_response",
  });
  for (mode of ["redirect", "denied", "large", "malformed", "invalid-json"]) {
    await assert.rejects(
      client.directory("synthetic-credential"),
      (error: Error) => {
        assert.equal(error.message.includes("never-expose-this"), false);
        return true;
      },
    );
  }
  assert.equal(redirected, false);
});

test(
  "a relay that stalls after response headers is interrupted by the upstream deadline",
  { timeout: 10_000 },
  async (t) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"devices":[');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(() => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const client = new RelayClient(`http://127.0.0.1:${address.port}`);
    await assert.rejects(client.directory("synthetic-credential"), {
      code: "relay_unavailable",
      status: 502,
    });
  },
);
