import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

import { parseRelayArgs } from "../src/cli-config.ts";
import {
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "../src/index.ts";

test("parseRelayArgs supports --portal-port and --portal-read-only and validates port isolation", () => {
  const parsed = parseRelayArgs([
    "--auth-config",
    "/tmp/auth.json",
    "--host",
    "127.0.0.1",
    "--port",
    "8788",
    "--portal-port",
    "8789",
    "--portal-read-only",
    "--allow-insecure-localhost",
    "--public-origin",
    "https://vaulter.tailf65eba.ts.net:8443",
    "--trust-proxy-headers",
  ]);
  assert.equal(parsed.port, 8788);
  assert.equal(parsed.portalPort, 8789);
  assert.equal(parsed.portalReadOnly, true);

  assert.throws(
    () =>
      parseRelayArgs([
        "--auth-config",
        "/tmp/auth.json",
        "--port",
        "8788",
        "--portal-port",
        "8788",
        "--allow-insecure-localhost",
      ]),
    /--portal-port must differ from --port/,
  );

  assert.throws(
    () =>
      parseRelayArgs([
        "--auth-config",
        "/tmp/auth.json",
        "--port",
        "8788",
        "--portal-port",
        "70000",
        "--allow-insecure-localhost",
      ]),
    /--portal-port must be an integer between 1 and 65535/,
  );
});

test("isolated --portal-port + --portal-read-only keeps Funnel port free of /portal and protects v0.1.0 agents", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tetherplane-private-pilot-"));
  const stateFile = path.join(dir, "devices.json");
  const ownerToken = "owner-pilot-token-123456";
  const privateOrigin = "https://vaulter.tailf65eba.ts.net:8443";
  const relay = await RelayServer.create({
    authenticator: new StaticClientAuthenticator([
      {
        token: ownerToken,
        accountId: "acct-owner",
        clientId: "existing-client",
        principalId: "human:acct-owner",
        role: "owner",
      },
      {
        token: "legacy-mcp-client-token",
        accountId: "acct-owner",
        clientId: "chatgpt-existing",
        principalId: "chatgpt:acct-owner",
      },
    ]),
    stateFile,
    allowInsecureLocalhost: true,
    publicOrigin: privateOrigin,
    trustProxyHeaders: true,
    portalPort: 0,
    portalReadOnly: true,
  });

  let legacySocket: WebSocket | null = null;
  try {
    const address = await relay.listen({ host: "127.0.0.1", port: 0 });
    assert.ok(address.portalListenUrl, "dedicated loopback portal URL should be reported");
    assert.ok(
      address.portalListenUrl.startsWith("http://127.0.0.1:"),
      "dedicated portal listener must bind to loopback only",
    );
    assert.notEqual(address.portalListenUrl, address.httpUrl);

    // 1. Main listener (public Funnel backend) MUST return 404 for all /portal* paths
    for (const p of [
      "/portal",
      "/portal/manifest.webmanifest",
      "/portal/api/session",
      "/portal/api/overview",
    ]) {
      const res = await fetch(`${address.httpUrl}${p}`);
      assert.equal(res.status, 404, `main relay listener must not expose ${p}`);
    }

    // Main listener health and existing control endpoints remain intact
    const health = await fetch(`${address.httpUrl}/healthz`);
    assert.equal(health.status, 200);

    // Dedicated portal listener MUST NOT expose /mcp or /devices
    const portalMcp = await fetch(`${address.portalListenUrl}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(portalMcp.status, 404);
    const portalDevices = await fetch(`${address.portalListenUrl}/devices`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(portalDevices.status, 404);

    // 2. Pair a device and connect a strict v0.1.0 agent that disconnects on any non-invoke message
    const deviceSecret = "v010-device-secret-9876543210";
    const startRes = await fetch(`${address.httpUrl}/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "Leno",
        credentialHash: hashDeviceCredential(deviceSecret),
      }),
    });
    assert.equal(startRes.status, 200);
    const { userCode } = (await startRes.json()) as { userCode: string };

    const approveRes = await fetch(`${address.httpUrl}/pair/approve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userCode }),
    });
    assert.equal(approveRes.status, 200);

    let unexpectedFrame: string | null = null;
    let socketClosed = false;
    legacySocket = new WebSocket(address.deviceWsUrl, {
      headers: {
        authorization: `Device ${deviceSecret}`,
        "x-tetherplane-device-id": "Leno",
      },
    });
    await new Promise<void>((resolve, reject) => {
      legacySocket!.once("open", () => resolve());
      legacySocket!.once("error", reject);
    });
    legacySocket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as {
        type?: string;
        routeId?: string;
        invocation?: { request_id: string };
      };
      // Mirrors origin/main agent/tetherd/src/relay_ws.rs: anything except "invoke" fails & closes!
      if (msg.type !== "invoke") {
        unexpectedFrame = String(raw);
        legacySocket!.close(1002, "unknown inbound message type");
        return;
      }
      legacySocket!.send(
        JSON.stringify({
          type: "result",
          routeId: msg.routeId,
          result: {
            protocol_version: "1.0",
            request_id: msg.invocation!.request_id,
            status: "success",
            data: { agent_version: "0.1.0", device: "Leno" },
            delta: null,
            error: null,
            verification: "verified",
            continuation: null,
            policy: null,
            timing: { duration_ms: 1 },
          },
        }),
      );
    });
    legacySocket.once("close", () => {
      socketClosed = true;
    });

    // 3. Dedicated portal listener serves HTML & authenticates behind private HTTPS origin
    const portalHtml = await fetch(`${address.portalListenUrl}/portal`);
    assert.equal(portalHtml.status, 200);

    const sessionRes = await fetch(`${address.portalListenUrl}/portal/api/session`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        origin: privateOrigin,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "vaulter.tailf65eba.ts.net:8443",
      },
    });
    assert.equal(sessionRes.status, 200);
    const setCookie = sessionRes.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookiePair = setCookie.split(";")[0]!;
    const { csrfToken } = (await sessionRes.json()) as { csrfToken: string };

    // 4. Read-only overview shows live Leno online presence without pushing policy_sync
    const overviewRes = await fetch(`${address.portalListenUrl}/portal/api/overview`, {
      headers: {
        cookie: cookiePair,
        origin: privateOrigin,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "vaulter.tailf65eba.ts.net:8443",
      },
    });
    assert.equal(overviewRes.status, 200);
    const overview = (await overviewRes.json()) as {
      devices: Array<{ deviceId: string; online: boolean; syncStatus: string }>;
    };
    assert.equal(overview.devices.length, 1);
    assert.equal(overview.devices[0]!.deviceId, "Leno");
    assert.equal(overview.devices[0]!.online, true);
    assert.equal(overview.devices[0]!.syncStatus, "pending");

    // 5. All portal mutation endpoints fail closed (403) in --portal-read-only mode
    const mutationCases: Array<{ method: string; path: string; body?: unknown }> = [
      {
        method: "POST",
        path: "/portal/api/devices/Leno/policy",
        body: { revokeFamilies: ["process"] },
      },
      {
        method: "POST",
        path: "/portal/api/global/apply",
        body: { confirm: true, profileId: "read_only" },
      },
      {
        method: "POST",
        path: "/portal/api/global/emergency-revoke",
        body: { confirm: true },
      },
      {
        method: "POST",
        path: "/portal/api/operators",
        body: { principalId: "operator:test", profileId: "read_only" },
      },
      {
        method: "DELETE",
        path: "/portal/api/operators/operator:test",
      },
      {
        method: "POST",
        path: "/portal/api/rollback",
        body: { deviceId: "Leno", targetRevision: 1 },
      },
    ];

    for (const c of mutationCases) {
      const headers: Record<string, string> = {
        cookie: cookiePair,
        origin: privateOrigin,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "vaulter.tailf65eba.ts.net:8443",
        "x-tetherplane-csrf": csrfToken,
      };
      const init: RequestInit = {
        method: c.method,
        headers,
      };
      if (c.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(c.body);
      }
      const res: Response = await fetch(
        `${address.portalListenUrl}${c.path}`,
        init,
      );
      assert.equal(
        res.status,
        403,
        `${c.method} ${c.path} must return 403 in read-only pilot mode`,
      );
      const errBody = (await res.json()) as { error?: { message?: string } };
      assert.match(errBody.error?.message ?? "", /read-only/i);
    }

    // 6. Existing MCP invocations (including non-canonical client principalId) keep working during read-only pilot
    const routeResult = await relay.router.call(
      {
        accountId: "acct-owner",
        clientId: "chatgpt-existing",
        principalId: "chatgpt:acct-owner",
      },
      {
        protocol_version: "1.0",
        request_id: "req-legacy-status",
        device_id: "Leno",
        principal_id: "chatgpt:acct-owner",
        job_id: null,
        actor: { id: "chatgpt-existing", kind: "ai_client" },
        session_id: null,
        capability: "device.status",
        arguments: {},
        response_mode: "compact",
        idempotency_key: null,
        preconditions: [],
        expectations: [],
      },
    );
    assert.equal(routeResult.status, "success");

    // 7. v0.1.0 agent received zero policy_sync frames and remained connected throughout
    const binding = relay.registry.getDevice("Leno");
    assert.ok(binding, "Leno device binding should exist");
    const policyRecord = await relay.policyStore.ensureDevicePolicy(binding);
    const pushed = await relay.router.pushPolicy("Leno", policyRecord.policy);
    assert.equal(pushed, false, "read-only pilot must never push policy_sync frames");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unexpectedFrame, null, "v0.1.0 agent must never receive policy_sync in read-only pilot");
    assert.equal(socketClosed, false, "v0.1.0 agent WebSocket must remain open");
  } finally {
    try {
      legacySocket?.close();
    } catch {
      // ignore
    }
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});
