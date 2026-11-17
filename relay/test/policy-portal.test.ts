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

async function until<T>(
  predicate: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 5_000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
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
          "read",
          "read_many",
          "list",
          "info",
          "write",
          "append",
          "mkdir",
          "move",
          "patch",
        ],
        available_operations: [
          "read",
          "read_many",
          "list",
          "info",
          "write",
          "append",
          "mkdir",
          "move",
          "patch",
        ],
        granted_operations: grantedFamilies.includes("files")
          ? [
              "read",
              "read_many",
              "list",
              "info",
              "write",
              "append",
              "mkdir",
              "move",
              "patch",
            ]
          : [],
        denied_operations: grantedFamilies.includes("files")
          ? []
          : [
              "read",
              "read_many",
              "list",
              "info",
              "write",
              "append",
              "mkdir",
              "move",
              "patch",
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

    // Update policy while device is OFFLINE: revoke desktop family and explicitly deny filesystem.write
    const updatedOffline = await jsonRequest(
      address.httpUrl,
      "/portal/api/devices/Leno/policy",
      {
        method: "POST",
        token: "owner-token-a",
        body: {
          revokeFamilies: ["desktop"],
          deniedCapabilities: ["filesystem.write"],
          reason: "Restrict desktop and file writes while travelling",
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
        "filesystem.write",
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
          deniedCapabilities: ["filesystem.write"],
          reason: "Grant read-only file access to build assistant",
        },
      },
    );
    assert.equal(opConfig.status, 200);

    // Operator can call filesystem.read
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
        capability: "filesystem.read",
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

test("canonical operations and permission profiles exclude phantom operations and align read_only semantics", async () => {
  const {
    CANONICAL_OPERATIONS_BY_FAMILY,
    createProfilePermissionSet,
    evaluatePermissionSet,
  } = await import("../src/index.ts");

  assert.deepEqual(CANONICAL_OPERATIONS_BY_FAMILY, {
    device: [
      "device.status",
      "device.capabilities",
      "job.create",
      "job.get",
      "job.list",
      "job.checkpoint",
      "job.acquire_lease",
      "job.release_lease",
      "audit.read",
    ],
    files: [
      "filesystem.read",
      "filesystem.read_many",
      "filesystem.list",
      "filesystem.info",
      "filesystem.write",
      "filesystem.append",
      "filesystem.mkdir",
      "filesystem.move",
      "filesystem.patch",
      "search.start",
      "search.read",
      "search.stop",
      "search.list",
    ],
    process: [
      "process.run",
      "process.read",
      "process.input",
      "process.list_sessions",
      "process.list_system",
      "process.terminate",
    ],
    browser: [
      "browser.status",
      "browser.pages",
      "browser.create_tab",
      "browser.snapshot",
      "browser.navigate",
      "browser.close",
      "browser.act",
      "browser.wait",
      "browser.upload",
      "browser.downloads",
      "browser.diagnostics",
      "browser.checkpoint",
    ],
    desktop: [
      "desktop.snapshot",
      "desktop.act",
      "desktop.private_clipboard_get",
      "desktop.private_clipboard_set",
      "desktop.foreground_lease_acquire",
      "desktop.foreground_lease_get",
      "desktop.foreground_lease_release",
      "desktop.physical_pointer_move",
    ],
    batch: ["batch.execute"],
  });

  const allCanonical = new Set(Object.values(CANONICAL_OPERATIONS_BY_FAMILY).flat());
  for (const profileId of [
    "universal",
    "standard",
    "files_and_process",
    "read_only",
    "lockdown",
  ] as const) {
    const profile = createProfilePermissionSet("human:test", "owner", profileId);
    for (const op of [...profile.allowed_capabilities, ...profile.denied_capabilities]) {
      assert.ok(
        allCanonical.has(op),
        `profile ${profileId} referenced non-canonical/phantom capability: ${op}`,
      );
    }
  }

  const readOnly = createProfilePermissionSet("operator:ro", "operator", "read_only");
  for (const op of [
    "device.status",
    "device.capabilities",
    "job.get",
    "job.list",
    "audit.read",
    "filesystem.read",
    "filesystem.read_many",
    "filesystem.list",
    "filesystem.info",
    "search.start",
    "search.read",
    "search.stop",
    "search.list",
    "browser.status",
    "browser.pages",
    "browser.snapshot",
    "browser.wait",
    "browser.downloads",
    "browser.diagnostics",
    "browser.checkpoint",
    "desktop.snapshot",
    "desktop.private_clipboard_get",
    "desktop.foreground_lease_get",
  ]) {
    assert.equal(
      evaluatePermissionSet(readOnly, op).allowed,
      true,
      `read_only profile should allow ${op}`,
    );
  }

  for (const op of [
    "job.create",
    "job.checkpoint",
    "job.acquire_lease",
    "job.release_lease",
    "filesystem.write",
    "filesystem.append",
    "filesystem.mkdir",
    "filesystem.move",
    "filesystem.patch",
    "process.run",
    "process.terminate",
    "browser.create_tab",
    "browser.navigate",
    "browser.close",
    "browser.act",
    "browser.upload",
    "desktop.act",
    "desktop.private_clipboard_set",
    "desktop.foreground_lease_acquire",
    "desktop.foreground_lease_release",
    "desktop.physical_pointer_move",
    "batch.execute",
  ]) {
    assert.equal(
      evaluatePermissionSet(readOnly, op).allowed,
      false,
      `read_only profile must deny mutating capability ${op}`,
    );
  }
});

test("monotonic policy revisions, rejected ACKs, operator ACK error reset, and reconnect sync behave securely", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-portal-monotonic-"));
  const relay = await RelayServer.create({
    authenticator: createTestAuthenticator(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const secret = "device-secret-leno-monotonic-test";

  try {
    await pairDevice(address.httpUrl, "Leno", secret);

    const connectDevice = async (
      appliedPolicyRevision: number | null,
      onPolicySync: (
        ws: WebSocket,
        policy: Record<string, any>,
      ) => void,
    ): Promise<WebSocket> => {
      const ws = new WebSocket(address.deviceWsUrl, {
        headers: {
          authorization: `Device ${secret}`,
          "x-tetherplane-device-id": "Leno",
        },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, any>;
        if (msg.type === "policy_sync") {
          onPolicySync(ws, msg.policy);
        }
      });
      ws.send(
        JSON.stringify({
          type: "device_hello",
          deviceId: "Leno",
          appliedPolicyRevision,
          status: { os: "linux", arch: "x86_64", agent_version: "0.1.0" },
        }),
      );
      return ws;
    };

    // 1. Connect and confirm rev 1, then update to rev 2 and reject rev 2 while delayed rev 1 ACK arrives
    const pushedOnFirstConnect: number[] = [];
    const ws1 = await connectDevice(null, (ws, policy) => {
      pushedOnFirstConnect.push(policy.revision);
      if (policy.revision === 1) {
        ws.send(
          JSON.stringify({
            type: "policy_ack",
            deviceId: "Leno",
            revision: 1,
            applied: true,
            appliedAtMs: Date.now(),
          }),
        );
      } else if (policy.revision === 2) {
        ws.send(
          JSON.stringify({
            type: "policy_ack",
            deviceId: "Leno",
            revision: 2,
            currentRevision: 1,
            applied: false,
            error: "simulated persistence failure at rev 2",
          }),
        );
        // Also send a delayed rev 1 ACK after failure — must NOT clear rev 2 error or mark rev 2 applied!
        ws.send(
          JSON.stringify({
            type: "policy_ack",
            deviceId: "Leno",
            revision: 1,
            applied: true,
            appliedAtMs: Date.now(),
          }),
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "policy_ack",
            deviceId: "Leno",
            revision: policy.revision,
            applied: true,
            appliedAtMs: Date.now(),
          }),
        );
      }
    });

    await new Promise((r) => setTimeout(r, 40));

    // Update policy to rev 2 -> device rejects it and sends delayed rev 1 ACK
    await jsonRequest(address.httpUrl, "/portal/api/devices/Leno/policy", {
      method: "POST",
      token: "owner-token-a",
      body: {
        revokeFamilies: ["process"],
        reason: "Revoke process at rev 2",
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    const afterReject = await jsonRequest(
      address.httpUrl,
      "/portal/api/overview",
      { method: "GET", token: "owner-token-a" },
    );
    const lenoRejected = afterReject.body.devices[0];
    assert.equal(lenoRejected.syncStatus, "failed");
    assert.equal(lenoRejected.confirmedByDevice, false);
    assert.equal(lenoRejected.desiredRevision, 2);
    assert.equal(lenoRejected.appliedRevision, 1);
    assert.match(lenoRejected.lastAckError, /simulated persistence failure/i);

    // 2. Subsequent operator update bumps to rev 3 and MUST clear prior lastAckError
    await jsonRequest(address.httpUrl, "/portal/api/operators", {
      method: "POST",
      token: "owner-token-a",
      body: {
        principalId: "operator:assistant-a",
        profileId: "read_only",
        deviceIds: ["Leno"],
        reason: "Add read-only operator at rev 3",
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const afterRev3 = await jsonRequest(
      address.httpUrl,
      "/portal/api/overview",
      { method: "GET", token: "owner-token-a" },
    );
    assert.equal(afterRev3.body.devices[0].syncStatus, "applied");
    assert.equal(afterRev3.body.devices[0].confirmedByDevice, true);
    assert.equal(afterRev3.body.devices[0].appliedRevision, 3);
    assert.equal(afterRev3.body.devices[0].lastAckError, null);

    ws1.close();
    await new Promise((r) => setTimeout(r, 30));

    // 3. Reconnect with older revision (e.g. 0): appliedRevision must reset until rev 3 is ACKed
    let deferAckResolve: (() => void) | null = null;
    const deferAckGate = new Promise<void>((r) => {
      deferAckResolve = r;
    });
    const pushedOnLagReconnect: number[] = [];
    const ws2 = await connectDevice(0, async (ws, policy) => {
      pushedOnLagReconnect.push(policy.revision);
      await deferAckGate;
      ws.send(
        JSON.stringify({
          type: "policy_ack",
          deviceId: "Leno",
          revision: policy.revision,
          applied: true,
          appliedAtMs: Date.now(),
        }),
      );
    });
    await new Promise((r) => setTimeout(r, 40));

    const whileWaitingReconnectAck = await jsonRequest(
      address.httpUrl,
      "/portal/api/overview",
      { method: "GET", token: "owner-token-a" },
    );
    assert.deepEqual(pushedOnLagReconnect, [3]);
    assert.equal(
      whileWaitingReconnectAck.body.devices[0].confirmedByDevice,
      false,
      "confirmedByDevice must reset to false when reconnecting with appliedPolicyRevision < desiredRevision",
    );
    assert.equal(whileWaitingReconnectAck.body.devices[0].syncStatus, "pending");
    assert.equal(whileWaitingReconnectAck.body.devices[0].appliedRevision, null);

    deferAckResolve!();
    await new Promise((r) => setTimeout(r, 40));
    ws2.close();
    await new Promise((r) => setTimeout(r, 30));

    // 4. Reconnect claiming appliedPolicyRevision=7 (> desiredRevision=3):
    // Relay must NOT push stale rev 3 downward, and next mutation must jump above 7 (to 8)
    const pushedWhenDeviceAhead: number[] = [];
    const ws3 = await connectDevice(7, (ws, policy) => {
      pushedWhenDeviceAhead.push(policy.revision);
      ws.send(
        JSON.stringify({
          type: "policy_ack",
          deviceId: "Leno",
          revision: policy.revision,
          applied: true,
          appliedAtMs: Date.now(),
        }),
      );
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(
      pushedWhenDeviceAhead,
      [],
      "relay must never push older desiredRevision when device already reports higher appliedPolicyRevision",
    );

    const aheadUpdate = await jsonRequest(
      address.httpUrl,
      "/portal/api/devices/Leno/policy",
      {
        method: "POST",
        token: "owner-token-a",
        body: {
          grantFamilies: ["process"],
          reason: "Advance above device-reported rev 7",
        },
      },
    );
    assert.equal(aheadUpdate.status, 200);
    assert.equal(aheadUpdate.body.device.desiredRevision, 8);
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(pushedWhenDeviceAhead, [8]);

    ws3.close();
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconciles real tetherd provider availability and object-map tool_families without phantom active ops", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-portal-telemetry-"));
  const relay = await RelayServer.create({
    authenticator: createTestAuthenticator(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const secret = "device-secret-leno-telemetry-test";

  try {
    await pairDevice(address.httpUrl, "Leno", secret);

    const ws = new WebSocket(address.deviceWsUrl, {
      headers: {
        authorization: `Device ${secret}`,
        "x-tetherplane-device-id": "Leno",
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    // Exact payload shape emitted by Rust tetherd AgentRuntime (note: no `status` or `name` on providers, object map `tool_families`)
    const rustLikeCapabilities = {
      effective_permissions: {
        emergency_lockdown: false,
        policy_revision: 1,
        policy_source: "synchronized",
        principal_id: "human:account-a",
        profile_id: "universal",
        role: "owner",
        universal_default: true,
      },
      providers: [
        {
          namespace: "device",
          tool_family: "device",
          available: true,
          unavailable_reason: null,
          available_operations: ["status", "capabilities"],
          granted_operations: ["status", "capabilities"],
          denied_operations: [],
          operations: ["status", "capabilities"],
        },
        {
          namespace: "filesystem",
          tool_family: "files",
          available: true,
          unavailable_reason: null,
          available_operations: ["read", "write"],
          granted_operations: ["read", "write"],
          denied_operations: [],
          operations: ["read", "write"],
        },
        {
          namespace: "browser",
          tool_family: "browser",
          available: false,
          unavailable_reason: "browser bridge extension is in standby",
          available_operations: [],
          granted_operations: [],
          denied_operations: [],
          operations: [],
        },
        {
          namespace: "desktop",
          tool_family: "desktop",
          available: false,
          unavailable_reason: "Windows UIA desktop provider requires a Windows host",
          available_operations: [],
          granted_operations: [],
          denied_operations: [],
          operations: [],
        },
      ],
      tool_families: {
        batch: {
          family: "batch",
          available: true,
          unavailable_reason: null,
          granted: true,
          available_operations: ["batch.execute"],
          granted_operations: ["batch.execute"],
          denied_operations: [],
        },
        browser: {
          family: "browser",
          available: false,
          unavailable_reason: "browser bridge extension is in standby",
          granted: true,
          available_operations: [],
          granted_operations: [],
          denied_operations: [],
        },
        desktop: {
          family: "desktop",
          available: false,
          unavailable_reason: "Windows UIA desktop provider requires a Windows host",
          granted: true,
          available_operations: [],
          granted_operations: [],
          denied_operations: [],
        },
        device: {
          family: "device",
          available: true,
          unavailable_reason: null,
          granted: true,
          available_operations: ["device.status", "device.capabilities"],
          granted_operations: ["device.status", "device.capabilities"],
          denied_operations: [],
        },
        files: {
          family: "files",
          available: true,
          unavailable_reason: null,
          granted: true,
          available_operations: ["filesystem.read", "filesystem.write"],
          granted_operations: ["filesystem.read", "filesystem.write"],
          denied_operations: [],
        },
        process: {
          family: "process",
          available: true,
          unavailable_reason: null,
          granted: true,
          available_operations: ["process.run"],
          granted_operations: ["process.run"],
          denied_operations: [],
        },
      },
    };

    const acked = new Promise<void>((resolve) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, any>;
        if (msg.type === "policy_sync") {
          ws.send(
            JSON.stringify({
              type: "policy_ack",
              deviceId: "Leno",
              revision: msg.policy.revision,
              applied: true,
              appliedAtMs: Date.now(),
              status: {
                os: "linux",
                arch: "x86_64",
                agent_version: "0.1.0",
                policy_mode: "background_only",
              },
              capabilities: rustLikeCapabilities,
            }),
          );
          resolve();
        }
      });
    });

    ws.send(
      JSON.stringify({
        type: "device_hello",
        deviceId: "Leno",
        appliedPolicyRevision: null,
        status: {
          os: "linux",
          arch: "x86_64",
          agent_version: "0.1.0",
          policy_mode: "background_only",
        },
        capabilities: rustLikeCapabilities,
      }),
    );

    await acked;
    await new Promise((r) => setTimeout(r, 40));

    const overview = await jsonRequest(address.httpUrl, "/portal/api/overview", {
      method: "GET",
      token: "owner-token-a",
    });
    assert.equal(overview.status, 200);
    const leno = overview.body.devices[0];
    assert.equal(leno.agentHealth, "degraded");
    assert.deepEqual(
      leno.unavailableCapabilities.map((u: Record<string, any>) => u.name),
      ["browser", "desktop"],
    );
    assert.match(leno.unavailableCapabilities[0].reason, /standby/i);

    const byFamily = Object.fromEntries(
      leno.familySummaries.map((f: Record<string, any>) => [f.family, f]),
    );
    assert.equal(byFamily.files.providerAvailable, true);
    assert.equal(byFamily.files.granted, true);
    assert.deepEqual(byFamily.files.availableOperations, [
      "filesystem.read",
      "filesystem.write",
    ]);
    assert.equal(byFamily.device.providerAvailable, true);
    assert.deepEqual(byFamily.device.availableOperations, [
      "device.status",
      "device.capabilities",
    ]);

    assert.equal(byFamily.browser.providerAvailable, false);
    assert.equal(byFamily.browser.granted, true);
    assert.deepEqual(byFamily.browser.availableOperations, []);
    assert.deepEqual(byFamily.browser.grantedOperations, []);
    assert.equal(byFamily.browser.policyGrantedOperations.length, 12);

    assert.equal(byFamily.desktop.providerAvailable, false);
    assert.equal(byFamily.desktop.granted, true);
    assert.deepEqual(byFamily.desktop.availableOperations, []);
    assert.deepEqual(byFamily.desktop.grantedOperations, []);
    assert.equal(byFamily.desktop.policyGrantedOperations.length, 8);

    ws.close();
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("portal SSE /portal/api/events enforces owner auth boundaries, streams policy_ack transitions live, and closes cleanly", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-portal-sse-"));
  const relay = await RelayServer.create({
    authenticator: createTestAuthenticator(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const secret = "device-secret-leno-sse-test-1234";

  try {
    await pairDevice(address.httpUrl, "Leno", secret);

    // 1. Security boundaries on /portal/api/events
    const anonRes = await fetch(`${address.httpUrl}/portal/api/events`);
    assert.equal(anonRes.status, 401);

    const queryTokenRes = await fetch(
      `${address.httpUrl}/portal/api/events?token=owner-token-a`,
    );
    assert.equal(queryTokenRes.status, 400);

    const opRes = await fetch(`${address.httpUrl}/portal/api/events`, {
      headers: { authorization: "Bearer operator-token-a" },
    });
    assert.equal(opRes.status, 403);

    // Create owner cookie session
    const sessionRes = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token-a" },
    });
    assert.equal(sessionRes.status, 200);
    const cookie = sessionRes.headers
      .getSetCookie()[0]!
      .split(";")[0]!;
    const { csrfToken } = (await sessionRes.json()) as { csrfToken: string };

    const crossSiteSse = await fetch(`${address.httpUrl}/portal/api/events`, {
      headers: {
        cookie,
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(crossSiteSse.status, 403);

    // Connect device WS cleanly
    const ws = new WebSocket(address.deviceWsUrl, {
      headers: {
        authorization: `Device ${secret}`,
        "x-tetherplane-device-id": "Leno",
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const pendingSyncs: Array<Record<string, any>> = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Record<string, any>;
      if (msg.type === "policy_sync") {
        pendingSyncs.push(msg.policy);
      }
    });

    ws.send(
      JSON.stringify({
        type: "device_hello",
        deviceId: "Leno",
        appliedPolicyRevision: null,
        status: { os: "linux", arch: "x86_64", agent_version: "0.1.0" },
        capabilities: sampleCapabilities("Leno"),
      }),
    );

    // Wait for initial rev 1 policy_sync, ACK it so rev 1 is settled
    await until(() => pendingSyncs.some((p) => p.revision === 1));
    ws.send(
      JSON.stringify({
        type: "policy_ack",
        deviceId: "Leno",
        revision: 1,
        applied: true,
        appliedAtMs: Date.now(),
      }),
    );

    // Open authenticated SSE stream using cookie
    const sseRes = await fetch(`${address.httpUrl}/portal/api/events`, {
      headers: {
        cookie,
        origin: address.httpUrl,
      },
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get("content-type") ?? "", /^text\/event-stream/i);

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: Array<{ event: string; data: string }> = [];

    const readLoop = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let eventName = "message";
          let data = "";
          for (const line of chunk.split(/\r?\n/)) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (data) events.push({ event: eventName, data });
        }
      }
    })();

    // Trigger policy update rev 2 while withholding ACK briefly
    const updateRes = await fetch(
      `${address.httpUrl}/portal/api/devices/Leno/policy`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: address.httpUrl,
          "x-tetherplane-csrf": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          revokeFamilies: ["desktop"],
          reason: "SSE live update verification",
        }),
      },
    );
    assert.equal(updateRes.status, 200);

    await until(() => pendingSyncs.some((p) => p.revision === 2));
    const countBeforeAck = events.filter((e) => e.event === "overview").length;

    // Now device sends delayed policy_ack for rev 2
    ws.send(
      JSON.stringify({
        type: "policy_ack",
        deviceId: "Leno",
        revision: 2,
        applied: true,
        appliedAtMs: Date.now(),
      }),
    );

    await until(
      () =>
        events.filter((e) => e.event === "overview").length > countBeforeAck,
      3_000,
      "SSE overview event after policy_ack",
    );

    const finalOverview = await jsonRequest(address.httpUrl, "/portal/api/overview", {
      method: "GET",
      token: "owner-token-a",
    });
    assert.equal(finalOverview.body.devices[0].syncStatus, "applied");
    assert.equal(finalOverview.body.devices[0].appliedRevision, 2);

    ws.close();
    // relay.close() MUST resolve promptly even with SSE still open
    await Promise.race([
      relay.close(),
      new Promise<never>((_res, rej) =>
        setTimeout(() => rej(new Error("relay.close hung with open SSE")), 3_000),
      ),
    ]);
    await readLoop.catch(() => {});
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("device_telemetry WebSocket updates transition browser availability and stream SSE overview events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tetherplane-telemetry-"));
  const relay = await RelayServer.create({
    authenticator: createTestAuthenticator(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const secret = "leno-secret-telemetry-0001";

  try {
    await pairDevice(address.httpUrl, "Leno", secret);
    const ws = new WebSocket(address.deviceWsUrl, {
      headers: {
        authorization: `Device ${secret}`,
        "x-tetherplane-device-id": "Leno",
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const standbyCaps = {
      providers: [
        {
          namespace: "device",
          tool_family: "device",
          available: true,
          unavailable_reason: null,
          available_operations: ["status", "capabilities"],
        },
        {
          namespace: "browser",
          tool_family: "browser",
          available: false,
          unavailable_reason: "Chrome extension is in standby / waiting for extension reconnect",
          available_operations: [],
        },
      ],
      tool_families: {
        device: {
          family: "device",
          available: true,
          unavailable_reason: null,
          granted: true,
          available_operations: ["device.status", "device.capabilities"],
        },
        browser: {
          family: "browser",
          available: false,
          unavailable_reason: "Chrome extension is in standby / waiting for extension reconnect",
          granted: true,
          available_operations: [],
        },
      },
    };

    ws.send(
      JSON.stringify({
        type: "device_hello",
        deviceId: "Leno",
        appliedPolicyRevision: 1,
        status: { os: "linux", arch: "x86_64", agent_version: "0.1.0" },
        capabilities: standbyCaps,
      }),
    );

    const standbyOverview = await until(async () => {
      const ov = await jsonRequest(address.httpUrl, "/portal/api/overview", {
        method: "GET",
        token: "owner-token-a",
      });
      const dev = ov.body.devices[0];
      return dev?.capabilities ? dev : null;
    });
    assert.equal(standbyOverview.agentHealth, "degraded");
    const standbyBrowser = standbyOverview.familySummaries.find((f: any) => f.family === "browser");
    assert.equal(standbyBrowser.providerAvailable, false);
    assert.deepEqual(standbyBrowser.availableOperations, []);

    const sessionRes = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: { authorization: "Bearer owner-token-a" },
    });
    assert.equal(sessionRes.status, 200);
    const cookie = sessionRes.headers.getSetCookie()[0]!.split(";")[0]!;

    const sseController = new AbortController();
    const sseRes = await fetch(`${address.httpUrl}/portal/api/events`, {
      method: "GET",
      headers: { Cookie: cookie },
      signal: sseController.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    const readLoop = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
      }
    })();

    const liveCaps = {
      providers: [
        {
          namespace: "device",
          tool_family: "device",
          available: true,
          unavailable_reason: null,
          available_operations: ["status", "capabilities"],
        },
        {
          namespace: "browser",
          tool_family: "browser",
          available: true,
          unavailable_reason: null,
          available_operations: ["status", "pages", "snapshot"],
        },
      ],
      tool_families: {
        device: {
          family: "device",
          available: true,
          unavailable_reason: null,
          granted: true,
          available_operations: ["device.status", "device.capabilities"],
        },
        browser: {
          family: "browser",
          available: true,
          unavailable_reason: null,
          granted: true,
          available_operations: ["browser.status", "browser.pages", "browser.snapshot"],
        },
      },
    };

    await until(() => (sseBuffer.includes("event: overview") ? true : null), 2_000, "initial SSE overview");

    ws.send(
      JSON.stringify({
        type: "device_telemetry",
        deviceId: "Leno",
        status: { os: "linux", arch: "x86_64", agent_version: "0.1.0" },
        capabilities: liveCaps,
      }),
    );

    await until(
      () => ((sseBuffer.match(/event: overview/g) ?? []).length >= 2 ? true : null),
      2_000,
      "SSE overview on device_telemetry",
    );

    const recoveredOverview = await jsonRequest(address.httpUrl, "/portal/api/overview", {
      method: "GET",
      token: "owner-token-a",
    });
    const recoveredDev = recoveredOverview.body.devices[0];
    assert.equal(recoveredDev.agentHealth, "healthy");
    const liveBrowser = recoveredDev.familySummaries.find((f: any) => f.family === "browser");
    assert.equal(liveBrowser.providerAvailable, true);
    assert.deepEqual(liveBrowser.availableOperations, [
      "browser.status",
      "browser.pages",
      "browser.snapshot",
    ]);

    sseController.abort();
    ws.close();
    await readLoop.catch(() => {});
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot persistence preserves rev 1 baselines, full overview history, and deviceIds scoped global/operator mutations", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tetherplane-snap-scope-"));
  const stateFile = path.join(dir, "devices.json");
  let relay = await RelayServer.create({
    authenticator: createTestAuthenticator(),
    stateFile,
    allowInsecureLocalhost: true,
  });
  let address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    await pairDevice(address.httpUrl, "Leno", "leno-secret-snap-123456");
    await pairDevice(address.httpUrl, "Surface", "surface-secret-snap-123456");

    // Scope operator ONLY to Leno (not Surface)
    const scopedOp = await jsonRequest(address.httpUrl, "/portal/api/operators", {
      method: "POST",
      token: "owner-token-a",
      body: {
        principalId: "operator:assistant-a",
        displayName: "Assistant Scoped",
        profileId: "read_only",
        deviceIds: ["Leno"],
        reason: "Scope operator to Leno only",
      },
    });
    assert.equal(scopedOp.status, 200);
    assert.deepEqual(scopedOp.body.updatedDevices, ["Leno"]);

    const ovAfterOp = await jsonRequest(address.httpUrl, "/portal/api/overview", {
      method: "GET",
      token: "owner-token-a",
    });
    const lenoDev = ovAfterOp.body.devices.find((d: any) => d.deviceId === "Leno");
    const surfaceDev = ovAfterOp.body.devices.find((d: any) => d.deviceId === "Surface");
    assert.ok(lenoDev.policy.operator_policies["operator:assistant-a"]);
    assert.equal(surfaceDev.policy.operator_policies["operator:assistant-a"], undefined);

    // Apply global change ONLY to Surface
    const scopedGlobal = await jsonRequest(address.httpUrl, "/portal/api/global/apply", {
      method: "POST",
      token: "owner-token-a",
      body: {
        confirm: true,
        profileId: "read_only",
        deviceIds: ["Surface"],
        reason: "Set Surface read-only only",
      },
    });
    assert.equal(scopedGlobal.status, 200);
    assert.deepEqual(scopedGlobal.body.updatedDevices, ["Surface"]);

    // Exceed both the old 50-overview slice and the old 200-persisted global slice
    for (let i = 0; i < 65; i += 1) {
      const res = await jsonRequest(address.httpUrl, "/portal/api/devices/Leno/policy", {
        method: "POST",
        token: "owner-token-a",
        body: {
          reason: `Leno snap step ${i}`,
          ...(i % 2 === 0 ? { revokeFamilies: ["process"] } : { grantFamilies: ["process"] }),
        },
      });
      assert.equal(res.status, 200);
    }
    for (let i = 0; i < 155; i += 1) {
      const res = await jsonRequest(address.httpUrl, "/portal/api/devices/Surface/policy", {
        method: "POST",
        token: "owner-token-a",
        body: {
          reason: `Surface snap step ${i}`,
          ...(i % 2 === 0 ? { revokeFamilies: ["files"] } : { grantFamilies: ["files"] }),
        },
      });
      assert.equal(res.status, 200);
    }

    // Restart Relay from persisted state and ensure rev 1 baselines + >50 snapshots per device survived
    await relay.close();
    relay = await RelayServer.create({
      authenticator: createTestAuthenticator(),
      stateFile,
      allowInsecureLocalhost: true,
    });
    address = await relay.listen({ host: "127.0.0.1", port: 0 });

    const reloaded = await jsonRequest(address.httpUrl, "/portal/api/overview", {
      method: "GET",
      token: "owner-token-a",
    });
    assert.equal(reloaded.status, 200);
    const snaps = reloaded.body.snapshots as Array<Record<string, any>>;
    const lenoSnaps = snaps.filter((s) => s.deviceId === "Leno");
    const surfaceSnaps = snaps.filter((s) => s.deviceId === "Surface");
    assert.ok(
      lenoSnaps.some((s) => s.revision === 1),
      "Leno rev 1 baseline snapshot must never be evicted past 200 global snapshots",
    );
    assert.ok(
      surfaceSnaps.some((s) => s.revision === 1),
      "Surface rev 1 baseline snapshot must be preserved",
    );
    assert.ok(
      lenoSnaps.length > 50,
      `Expected >50 Leno snapshots in overview (got ${lenoSnaps.length})`,
    );
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});
