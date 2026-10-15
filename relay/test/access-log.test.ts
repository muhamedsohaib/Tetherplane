import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";
import { loadClientAuth } from "../src/cli-config.ts";
import { RelayServer } from "../src/server.ts";

const oauth = {
  resource: "https://relay.example/mcp",
  issuer: "https://identity.example/",
  scopes: ["tetherplane:access"],
};

async function loggedServer(dir: string, accessLogFile: string) {
  return RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    authenticator: auth(),
    oauth,
    allowInsecureLocalhost: true,
    accessLogFile,
  });
}

function entriesOf(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("access log records arrival and completion without sensitive values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-relay-access-"));
  const accessLogFile = path.join(dir, "access.jsonl");
  const relay = await loggedServer(dir, accessLogFile);

  try {
    const address = await relay.listen({ host: "127.0.0.1", port: 0 });

    const health = await fetch(
      `${address.httpUrl}/healthz?token=should-never-appear`,
      {
        headers: { authorization: "Bearer should-never-appear" },
        signal: AbortSignal.timeout(2_000),
      },
    );
    assert.equal(health.status, 200);
    await health.text();

    const missing = await fetch(`${address.httpUrl}/no-such-tp-route`, {
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(missing.status, 404);
    await missing.text();

    const raw = await readFile(accessLogFile, "utf8");
    assert.ok(!raw.includes("should-never-appear"));
    const entries = entriesOf(raw);
    const starts = entries.filter((e) => e.event === "start");
    const finishes = entries.filter((e) => e.event === "finish");
    assert.ok(starts.length >= 2);
    assert.equal(starts.length, finishes.length);
    for (const start of starts) {
      assert.match(String(start.method), /^(GET|POST|DELETE)$/);
      assert.ok(!String(start.path).includes("?"));
      const end = finishes.find((f) => f.id === start.id);
      assert.ok(end);
      assert.equal(typeof end.status, "number");
      assert.equal(typeof end.durationMs, "number");
    }
    const healthStart = starts.find((s) => s.path === "/healthz");
    assert.ok(healthStart);
    const healthEnd = finishes.find((f) => f.id === healthStart.id);
    assert.equal(healthEnd?.status, 200);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("access log records validated MCP method names without arguments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-relay-access-mcp-"));
  const accessLogFile = path.join(dir, "access.jsonl");
  const relay = await loggedServer(dir, accessLogFile);

  try {
    const address = await relay.listen({ host: "127.0.0.1", port: 0 });

    const forged = "forged-principal-must-never-appear";
    const initialize = await fetch(`${address.httpUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "access-log-test", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(initialize.status, 200);
    await initialize.text();

    const call = await fetch(`${address.httpUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "device",
          arguments: { op: "status", principal_id: forged },
        },
      }),
      signal: AbortSignal.timeout(2_000),
    });
    await call.text();

    const raw = await readFile(accessLogFile, "utf8");
    assert.ok(!raw.includes(forged));
    const entries = entriesOf(raw);
    const methods = new Set(
      entries.filter((e) => typeof e.mcpMethod === "string").map((e) => e.mcpMethod),
    );
    assert.ok(methods.has("initialize"));
    assert.ok(methods.has("tools/call"));
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("access log is off by default and bounded when enabled", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-relay-access-off-"));
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    authenticator: auth(),
    oauth,
    allowInsecureLocalhost: true,
  });

  try {
    const address = await relay.listen({ host: "127.0.0.1", port: 0 });
    const health = await fetch(`${address.httpUrl}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(health.status, 200);
    await health.text();
    let missing = false;
    try {
      await readFile(path.join(dir, "access.jsonl"), "utf8");
    } catch {
      missing = true;
    }
    assert.equal(missing, true);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("diagnostics accessLogFile config is strictly validated", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-relay-access-cfg-"));
  try {
    const base = {
      oidc: {
        issuer: "https://identity.example/",
        audience: "https://relay.example/mcp",
        jwksUri: "https://identity.example/jwks",
        scopes: ["tetherplane:access"],
        identity: { strategy: "subject", principalPrefix: "human:" },
      },
      deviceLoginBridge: { tokenEnv: "TETHER_ACCESS_TEST_BRIDGE" },
    };
    const good = path.join(dir, "good.json");
    await writeFile(
      good,
      JSON.stringify({
        ...base,
        diagnostics: { accessLogFile: path.join(dir, "access.jsonl") },
      }),
    );
    const loaded = await loadClientAuth(good, {
      TETHER_ACCESS_TEST_BRIDGE:
        "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });
    assert.equal(loaded.accessLogFile, path.join(dir, "access.jsonl"));

    const relative = path.join(dir, "relative.json");
    await writeFile(
      relative,
      JSON.stringify({
        ...base,
        diagnostics: { accessLogFile: "access.jsonl" },
      }),
    );
    await assert.rejects(
      loadClientAuth(relative, {
        TETHER_ACCESS_TEST_BRIDGE:
          "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      }),
      /absolute/,
    );

    const missingParent = path.join(dir, "missing-parent.json");
    await writeFile(
      missingParent,
      JSON.stringify({
        ...base,
        diagnostics: {
          accessLogFile: path.join(dir, "no-such-dir", "access.jsonl"),
        },
      }),
    );
    await assert.rejects(
      loadClientAuth(missingParent, {
        TETHER_ACCESS_TEST_BRIDGE:
          "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      }),
      /parent directory/,
    );

    const plain = path.join(dir, "plain.json");
    await writeFile(plain, JSON.stringify(base));
    const withoutDiagnostics = await loadClientAuth(plain, {
      TETHER_ACCESS_TEST_BRIDGE:
        "TEST_BRIDGE_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });
    assert.equal(withoutDiagnostics.accessLogFile, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function auth(): StaticClientAuthenticator {
  return new StaticClientAuthenticator([
    {
      token: "relay-access-test-token",
      accountId: "account-a",
      clientId: "client-a",
      principalId: "human:account-a",
    },
  ]);
}
