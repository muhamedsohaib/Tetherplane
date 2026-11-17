import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import WebSocket from "ws";

import {
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "../src/index.ts";

function createTestAuthenticator(): StaticClientAuthenticator {
  return new StaticClientAuthenticator([
    {
      token: "owner-token-a",
      accountId: "account-a",
      clientId: "portal-owner-a",
      principalId: "human:account-a",
    },
    {
      token: "operator-token-a",
      accountId: "account-a",
      clientId: "assistant-client-a",
      principalId: "operator:assistant-a",
    },
    {
      token: "unregistered-operator-token-a",
      accountId: "account-a",
      clientId: "rogue-client-a",
      principalId: "operator:unregistered",
    },
    {
      token: "owner-token-b",
      accountId: "account-b",
      clientId: "portal-owner-b",
      principalId: "human:account-b",
    },
  ]);
}

async function jsonRequest(
  baseUrl: string,
  pathname: string,
  options: {
    method: "GET" | "POST" | "DELETE";
    token?: string;
    body?: Record<string, unknown>;
  },
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, any>) : {},
  };
}

async function pairDevice(
  baseUrl: string,
  deviceId: string,
  secret: string,
  ownerToken = "owner-token-a",
): Promise<void> {
  const started = await jsonRequest(baseUrl, "/pair/start", {
    method: "POST",
    body: {
      deviceId,
      credentialHash: hashDeviceCredential(secret),
    },
  });
  assert.equal(started.status, 200);
  const approved = await jsonRequest(baseUrl, "/pair/approve", {
    method: "POST",
    token: ownerToken,
    body: {
      userCode: started.body.userCode,
    },
  });
  assert.equal(approved.status, 200);
}

function sampleCapabilities(
  deviceId: string,
  grantedFamilies: string[] = [
    "device",
    "files",
    "process",
    "browser",
    "desktop",
    "batch",
  ],
) {
  return {
    device_id: deviceId,
    providers: [
      {
        name: "filesystem",
        tool_family: "files",
        status: "ready",
        unavailable_reason: null,
        operations: [
          "stat",
          "list",
          "read_text",
          "write_text",
          "patch",
          "mkdir",
          "move",
          "copy",
          "delete",
        ],
        available_operations: [
          "stat",
          "list",
          "read_text",
          "write_text",
          "patch",
          "mkdir",
          "move",
          "copy",
          "delete",
        ],
        granted_operations: grantedFamilies.includes("files")
          ? [
              "stat",
              "list",
              "read_text",
              "write_text",
              "patch",
              "mkdir",
              "move",
              "copy",
              "delete",
            ]
          : [],
        denied_operations: grantedFamilies.includes("files")
          ? []
          : [
              "stat",
              "list",
              "read_text",
              "write_text",
              "patch",
              "mkdir",
              "move",
              "copy",
              "delete",
            ],
      },
      {
        name: "browser",
        tool_family: "browser",
        status: "unavailable",
        unavailable_reason: "Extension websocket in standby",
        operations: [],
        available_operations: [],
        granted_operations: [],
        denied_operations: [],
      },
    ],
    tool_families: [
      "device",
      "files",
      "process",
      "browser",
      "desktop",
      "batch",
    ].map((family) => ({
      family,
      granted: grantedFamilies.includes(family),
      provider_available: family !== "browser",
      available_operations: family === "browser" ? [] : [`${family}.op`],
      granted_operations:
        family !== "browser" && grantedFamilies.includes(family)
          ? [`${family}.op`]
          : [],
      denied_operations: grantedFamilies.includes(family)
        ? []
        : [`${family}.op`],
    })),
  };
}

test("newly owner-paired device gets universal default policy, stays pending until device policy_ack, and reports live capabilities", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-portal-test-"));
  const relay = await RelayServer.create({
    authenticator: createTestAuthenticator(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const secret = "device-secret-leno-universal-test";

  try {
    await pairDevice(address.httpUrl, "Leno", secret);

    const beforeConnect = await jsonRequest(
      address.httpUrl,
      "/portal/api/overview",
      {
        method: "GET",
        token: "owner-token-a",
      },
    );
    assert.equal(beforeConnect.status, 200);
    assert.equal(beforeConnect.body.devices.length, 1);
    const lenoOffline = beforeConnect.body.devices[0];
    assert.equal(lenoOffline.deviceId, "Leno");
    assert.equal(lenoOffline.online, false);
    assert.equal(lenoOffline.syncStatus, "pending");
    assert.equal(lenoOffline.confirmedByDevice, false);
    assert.equal(lenoOffline.desiredRevision, 1);
    assert.equal(lenoOffline.appliedRevision, null);
    assert.equal(lenoOffline.policy.owner_policy.universal_permissions, true);
    assert.deepEqual(lenoOffline.policy.owner_policy.allowed_families, [
      "batch",
      "browser",
      "desktop",
      "device",
      "files",
      "process",
    ]);

    const syncedPolicies: Array<Record<string, any>> = [];
    const socket = new WebSocket(address.deviceWsUrl, {
      headers: {
        authorization: `Device ${secret}`,
        "x-tetherplane-device-id": "Leno",
      },
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const policySyncDone = new Promise<void>((resolve) => {
      socket.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, any>;
        if (msg.type === "policy_sync") {
          syncedPolicies.push(msg.policy);
          socket.send(
            JSON.stringify({
              type: "policy_ack",
              deviceId: "Leno",
              revision: msg.policy.revision,
              applied: true,
              appliedAtMs: Date.now(),
              status: {
                platform: "linux",
                version: "0.1.0",
                providers: 7,
                active_jobs: 0,
              },
              capabilities: sampleCapabilities("Leno"),
            }),
          );
          resolve();
        }
      });
    });

    socket.send(
      JSON.stringify({
        type: "device_hello",
        deviceId: "Leno",
        appliedPolicyRevision: null,
        status: {
          platform: "linux",
          version: "0.1.0",
          providers: 7,
          active_jobs: 0,
        },
        capabilities: sampleCapabilities("Leno"),
      }),
    );

    await policySyncDone;
    await new Promise((r) => setTimeout(r, 25));

    const afterConnect = await jsonRequest(
      address.httpUrl,
      "/portal/api/overview",
      {
        method: "GET",
        token: "owner-token-a",
      },
    );
    assert.equal(afterConnect.status, 200);
    const lenoOnline = afterConnect.body.devices[0];
    assert.equal(lenoOnline.online, true);
    assert.equal(lenoOnline.syncStatus, "applied");
    assert.equal(lenoOnline.confirmedByDevice, true);
    assert.equal(lenoOnline.desiredRevision, 1);
    assert.equal(lenoOnline.appliedRevision, 1);
    assert.equal(lenoOnline.status.platform, "linux");
    assert.equal(
      lenoOnline.unavailableCapabilities[0].name,
      "browser",
    );
    assert.match(
      lenoOnline.unavailableCapabilities[0].reason,
      /standby/i,
    );

    socket.close();
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("one-click device policy updates, explicit deny rules, offline pending state, reconnect sync, and safe rollback", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-portal-sync-"));
  const relay = await RelayServer.create({
    authenticator: createTestAuthenticator(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const secret = "device-secret-leno-policy-sync";

  try {
    await pairDevice(address.httpUrl, "Leno", secret);

    // Update policy while device is OFFLINE: revoke desktop family and explicitly deny filesystem.delete
    const updatedOffline = await jsonRequest(
      address.httpUrl,
      "/portal/api/devices/Leno/policy",
      {
        method: "POST",
        token: "owner-token-a",
        body: {
          revokeFamilies: ["desktop"],
          deniedCapabilities: ["filesystem.delete"],
          reason: "Restrict desktop and file deletion while travelling",
        },
      },
    );
    assert.equal(updatedOffline.status, 200);
    assert.equal(updatedOffline.body.device.syncStatus, "pending");
    assert.equal(updatedOffline.body.device.confirmedByDevice, false);
    assert.equal(updatedOffline.body.device.desiredRevision, 2);
    assert.equal(updatedOffline.body.device.appliedRevision, null);
    assert.ok(
      updatedOffline.body.device.policy.owner_policy.denied_families.includes(
        "desktop",
      ),
    );
    assert.ok(
      updatedOffline.body.device.policy.owner_policy.denied_capabilities.includes(
        "filesystem.delete",
      ),
    );

    // Connect device and verify policy_sync for revision 2 is pushed and acknowledged
    const socket = new WebSocket(address.deviceWsUrl, {
      headers: {
        authorization: `Device ${secret}`,
        "x-tetherplane-device-id": "Leno",
      },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    socket.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, any>;
      if (msg.type === "policy_sync") {
        socket.send(
          JSON.stringify({
            type: "policy_ack",
            deviceId: "Leno",
            revision: msg.policy.revision,
            applied: true,
            appliedAtMs: Date.now(),
            status: { platform: "linux", version: "0.1.0" },
            capabilities: sampleCapabilities("Leno", [
              "device",
              "files",
              "process",
              "browser",
              "batch",
            ]),
          }),
        );
      }
    });

    socket.send(
      JSON.stringify({
        type: "device_hello",
        deviceId: "Leno",
        appliedPolicyRevision: 1,
        status: { platform: "linux", version: "0.1.0" },
        capabilities: sampleCapabilities("Leno"),
      }),
    );

    await new Promise((r) => setTimeout(r, 40));

    const afterReconnect = await jsonRequest(
      address.httpUrl,
      "/portal/api/overview",
      {
        method: "GET",
        token: "owner-token-a",
      },
    );
    const lenoSynced = afterReconnect.body.devices[0];
    assert.equal(lenoSynced.syncStatus, "applied");
    assert.equal(lenoSynced.confirmedByDevice, true);
    assert.equal(lenoSynced.desiredRevision, 2);
    assert.equal(lenoSynced.appliedRevision, 2);

    // Roll back to revision 1 (universal default)
    const rolledBack = await jsonRequest(
      address.httpUrl,
      "/portal/api/rollback",
      {
        method: "POST",
        token: "owner-token-a",
        body: {
          deviceId: "Leno",
          targetRevision: 1,
          reason: "Restore universal permissions after trip",
        },
      },
    );
    assert.equal(rolledBack.status, 200);
    await new Promise((r) => setTimeout(r, 40));

    const afterRollback = await jsonRequest(
      address.httpUrl,
      "/portal/api/overview",
      {
        method: "GET",
        token: "owner-token-a",
      },
    );
    const lenoRestored = afterRollback.body.devices[0];
    assert.equal(lenoRestored.desiredRevision, 3);
    assert.equal(lenoRestored.appliedRevision, 3);
    assert.equal(lenoRestored.syncStatus, "applied");
    assert.deepEqual(
      lenoRestored.policy.owner_policy.denied_families,
      [],
    );
    assert.deepEqual(
      lenoRestored.policy.owner_policy.denied_capabilities,
      [],
    );

    socket.close();
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("global controls, emergency access revocation, operator identity scoping, and audit history work end-to-end", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-portal-global-"));
  const relay = await RelayServer.create({
    authenticator: createTestAuthenticator(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const secret1 = "device-secret-leno-global-1";
  const secret2 = "device-secret-workstation-global-2";

  try {
    await pairDevice(address.httpUrl, "Leno", secret1);
    await pairDevice(address.httpUrl, "Workstation", secret2);

    const socket1 = new WebSocket(address.deviceWsUrl, {
      headers: {
        authorization: `Device ${secret1}`,
        "x-tetherplane-device-id": "Leno",
      },
    });
    await new Promise<void>((resolve, reject) => {
      socket1.once("open", resolve);
      socket1.once("error", reject);
    });
    socket1.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, any>;
      if (msg.type === "policy_sync") {
        socket1.send(
          JSON.stringify({
            type: "policy_ack",
            deviceId: "Leno",
            revision: msg.policy.revision,
            applied: true,
            appliedAtMs: Date.now(),
          }),
        );
      } else if (msg.type === "invoke") {
        socket1.send(
          JSON.stringify({
            type: "result",
            routeId: msg.routeId,
            result: {
              protocol_version: "1.0",
              request_id: msg.invocation.request_id,
              status: "success",
              data: { executed: msg.invocation.capability },
              delta: null,
              error: null,
              verification: "passed",
              continuation: null,
              policy: null,
              timing: { duration_ms: 1 },
            },
          }),
        );
      }
    });

    // Configure an operator identity with only 'files' and 'device' families
    const opConfig = await jsonRequest(
      address.httpUrl,
      "/portal/api/operators",
      {
        method: "POST",
        token: "owner-token-a",
        body: {
          principalId: "operator:assistant-a",
          displayName: "Build Assistant",
          deviceIds: ["Leno"],
          allowedFamilies: ["device", "files"],
          deniedCapabilities: ["filesystem.delete"],
          reason: "Grant read/write file access to build assistant",
        },
      },
    );
    assert.equal(opConfig.status, 200);

    // Operator can call filesystem.read_text
    const opRead = await relay.router.call(
      {
        accountId: "account-a",
        clientId: "assistant-client-a",
        principalId: "operator:assistant-a",
      },
      {
        protocol_version: "1.0",
        request_id: "req-op-read-1",
        principal_id: null,
        device_id: "Leno",
        job_id: null,
        capability: "filesystem.read_text",
        arguments: { path: "/tmp/readme.txt" },
        actor: { id: "assistant", kind: "ai_client" },
        session_id: null,
        response_mode: "compact",
        idempotency_key: null,
        preconditions: [],
        expectations: [],
      },
    );
    assert.equal(opRead.status, "success");

    // Operator is denied process.run
    const opProc = await relay.router.call(
      {
        accountId: "account-a",
        clientId: "assistant-client-a",
        principalId: "operator:assistant-a",
      },
      {
        protocol_version: "1.0",
        request_id: "req-op-proc-1",
        principal_id: null,
        device_id: "Leno",
        job_id: null,
        capability: "process.run",
        arguments: { executable: "echo" },
        actor: { id: "assistant", kind: "ai_client" },
        session_id: null,
        response_mode: "compact",
        idempotency_key: null,
        preconditions: [],
        expectations: [],
      },
    );
    assert.equal(opProc.status, "error");
    assert.equal(opProc.error?.code, "permission_denied");

    // Unregistered operator identity on same account is denied
    const rogueCall = await relay.router.call(
      {
        accountId: "account-a",
        clientId: "rogue-client-a",
        principalId: "operator:unregistered",
      },
      {
        protocol_version: "1.0",
        request_id: "req-rogue-1",
        principal_id: null,
        device_id: "Leno",
        job_id: null,
        capability: "device.status",
        arguments: {},
        actor: { id: "rogue", kind: "ai_client" },
        session_id: null,
        response_mode: "compact",
        idempotency_key: null,
        preconditions: [],
        expectations: [],
      },
    );
    assert.equal(rogueCall.status, "error");
    assert.equal(rogueCall.error?.code, "permission_denied");

    // Global bulk change without confirm: true is rejected
    const unconfirmedGlobal = await jsonRequest(
      address.httpUrl,
      "/portal/api/global/emergency-revoke",
      {
        method: "POST",
        token: "owner-token-a",
        body: {
          reason: "Accidental click without confirmation",
        },
      },
    );
    assert.equal(unconfirmedGlobal.status, 400);

    // Confirmed emergency access revocation locks down all devices
    const emergency = await jsonRequest(
      address.httpUrl,
      "/portal/api/global/emergency-revoke",
      {
        method: "POST",
        token: "owner-token-a",
        body: {
          confirm: true,
          reason: "Security drill emergency lockdown",
        },
      },
    );
    assert.equal(emergency.status, 200);

    const ownerDuringLockdown = await relay.router.call(
      {
        accountId: "account-a",
        clientId: "portal-owner-a",
        principalId: "human:account-a",
      },
      {
        protocol_version: "1.0",
        request_id: "req-owner-lockdown-1",
        principal_id: null,
        device_id: "Leno",
        job_id: null,
        capability: "device.status",
        arguments: {},
        actor: { id: "owner", kind: "ai_client" },
        session_id: null,
        response_mode: "compact",
        idempotency_key: null,
        preconditions: [],
        expectations: [],
      },
    );
    assert.equal(ownerDuringLockdown.status, "error");
    assert.equal(ownerDuringLockdown.error?.code, "permission_denied");
    assert.equal(
      ownerDuringLockdown.error?.details?.denial_kind,
      "emergency_lockdown",
    );

    // Check overview for identityUsage and audit log
    const overview = await jsonRequest(
      address.httpUrl,
      "/portal/api/overview",
      {
        method: "GET",
        token: "owner-token-a",
      },
    );
    assert.equal(overview.status, 200);
    assert.ok(Array.isArray(overview.body.identityUsage));
    assert.ok(
      overview.body.identityUsage.some(
        (u: Record<string, any>) =>
          u.principalId === "operator:assistant-a" &&
          u.authorizedCount >= 1 &&
          u.deniedCount >= 1,
      ),
    );
    assert.ok(Array.isArray(overview.body.auditHistory));
    assert.ok(
      overview.body.auditHistory.some(
        (a: Record<string, any>) =>
          a.action === "emergency_lockdown" &&
          a.actorPrincipalId === "human:account-a",
      ),
    );

    // Verify GET /portal serves HTML dashboard
    const htmlRes = await fetch(`${address.httpUrl}/portal`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Tetherplane Control Portal/i);

    socket1.close();
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});
