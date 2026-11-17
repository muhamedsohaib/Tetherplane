import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from "jose";

import {
  DeviceRegistry,
  OidcClientAuthenticator,
  PolicyStore,
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "../src/index.ts";
import { loadClientAuth } from "../src/cli-config.ts";

async function jsonReq(
  baseUrl: string,
  pathname: string,
  options: {
    method: "GET" | "POST" | "DELETE";
    token?: string;
    body?: Record<string, unknown>;
  },
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: options.method,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, any>) : {},
  };
}

async function pairDevice(
  baseUrl: string,
  deviceId: string,
  secret: string,
  ownerToken: string,
): Promise<void> {
  const start = await jsonReq(baseUrl, "/pair/start", {
    method: "POST",
    body: {
      deviceId,
      credentialHash: hashDeviceCredential(secret),
    },
  });
  assert.equal(start.status, 200);
  const approve = await jsonReq(baseUrl, "/pair/approve", {
    method: "POST",
    token: ownerToken,
    body: { userCode: start.body.userCode },
  });
  assert.equal(approve.status, 200);
}

test("F-1: non-owner prefixes and unapproved human delegates cannot access portal or inherit owner policy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-f1-static-"));
  const nonOwnerTokens = [
    { token: "service-tok", clientId: "ci-runner", principalId: "service:ci" },
    { token: "client-tok", clientId: "bot-client", principalId: "client:bot" },
    { token: "delegate-tok", clientId: "delegate-app", principalId: "human:delegate" },
    { token: "custom-tok", clientId: "oidc-client", principalId: "oidc:account-a" },
    { token: "unknown-tok", clientId: "misc-client", principalId: "unknown:user" },
    { token: "operator-tok", clientId: "op-client", principalId: "operator:helper" },
  ];

  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
    authenticator: new StaticClientAuthenticator([
      {
        token: "owner-tok",
        accountId: "account-a",
        clientId: "owner-client",
        principalId: "human:account-a",
      },
      ...nonOwnerTokens.map((entry) => ({
        ...entry,
        accountId: "account-a",
      })),
    ]),
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    await pairDevice(address.httpUrl, "Leno", "leno-f1-device-secret-32chars-12", "owner-tok");

    for (const candidate of nonOwnerTokens) {
      const sessionRes = await jsonReq(address.httpUrl, "/portal/api/session", {
        method: "POST",
        token: candidate.token,
      });
      assert.equal(
        sessionRes.status,
        403,
        `${candidate.principalId} must be denied /portal/api/session`,
      );

      const overviewRes = await jsonReq(address.httpUrl, "/portal/api/overview", {
        method: "GET",
        token: candidate.token,
      });
      assert.equal(
        overviewRes.status,
        403,
        `${candidate.principalId} must be denied /portal/api/overview`,
      );

      const policyRes = await jsonReq(address.httpUrl, "/portal/api/devices/Leno/policy", {
        method: "POST",
        token: candidate.token,
        body: { profileId: "lockdown", reason: "unauthorized" },
      });
      assert.equal(
        policyRes.status,
        403,
        `${candidate.principalId} must be denied device policy mutation`,
      );

      const globalRes = await jsonReq(address.httpUrl, "/portal/api/global/apply", {
        method: "POST",
        token: candidate.token,
        body: { confirm: true, profileId: "lockdown" },
      });
      assert.equal(
        globalRes.status,
        403,
        `${candidate.principalId} must be denied global apply`,
      );

      const evalDecision = relay.policyStore.evaluateAndRecordInvocation({
        identity: {
          accountId: "account-a",
          clientId: candidate.clientId,
          principalId: candidate.principalId,
        },
        deviceId: "Leno",
        capability: "device.status",
      });
      assert.equal(
        evalDecision.allowed,
        false,
        `${candidate.principalId} must not inherit owner policy on relay routing`,
      );
      assert.equal(evalDecision.denialKind, "unpaired_or_unauthorized_identity");
    }
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-1: explicit role:'owner' works across static/OIDC configs and rejects reserved non-owner prefixes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-f1-role-"));
  const authPath = path.join(dir, "static-auth.json");
  await writeFile(
    authPath,
    JSON.stringify({
      clients: [
        {
          token_env: "TETHER_TEST_OWNER_ROLE",
          account_id: "account-a",
          client_id: "explicit-owner",
          principal_id: "custom-owner:primary",
          role: "owner",
        },
        {
          token_env: "TETHER_TEST_OP_ROLE",
          account_id: "account-a",
          client_id: "explicit-operator",
          principal_id: "human:op-but-marked-operator",
          role: "operator",
        },
      ],
    }),
    "utf8",
  );

  const loaded = await loadClientAuth(authPath, {
    TETHER_TEST_OWNER_ROLE: "explicit-owner-secret",
    TETHER_TEST_OP_ROLE: "explicit-operator-secret",
  });

  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
    authenticator: loaded.authenticator,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    await pairDevice(
      address.httpUrl,
      "Surface",
      "surface-f1-device-secret-32chars",
      "explicit-owner-secret",
    );

    const ownerSession = await jsonReq(address.httpUrl, "/portal/api/session", {
      method: "POST",
      token: "explicit-owner-secret",
    });
    assert.equal(ownerSession.status, 200);
    assert.equal(ownerSession.body.ownerPrincipalId, "custom-owner:primary");

    const ownerIdentity = await loaded.authenticator.authenticate("explicit-owner-secret");
    assert.ok(ownerIdentity);
    const allowedDecision = relay.policyStore.evaluateAndRecordInvocation({
      identity: ownerIdentity,
      deviceId: "Surface",
      capability: "process.run",
    });
    assert.equal(allowedDecision.allowed, true);

    const opSession = await jsonReq(address.httpUrl, "/portal/api/session", {
      method: "POST",
      token: "explicit-operator-secret",
    });
    assert.equal(opSession.status, 403);

    const opIdentity = await loaded.authenticator.authenticate("explicit-operator-secret");
    assert.ok(opIdentity);
    const deniedDecision = relay.policyStore.evaluateAndRecordInvocation({
      identity: opIdentity,
      deviceId: "Surface",
      capability: "device.status",
    });
    assert.equal(deniedDecision.allowed, false);
    assert.equal(deniedDecision.denialKind, "unpaired_or_unauthorized_identity");

    // Static authenticator & OIDC reject role:'owner' assigned to reserved non-owner prefixes
    assert.throws(
      () =>
        new StaticClientAuthenticator([
          {
            token: "bad-tok",
            accountId: "account-a",
            clientId: "bad",
            principalId: "service:ci",
            role: "owner",
          },
        ]),
      /non-owner|owner role|service:/i,
    );

    const keys = await generateKeyPair("RS256");
    const jwk = await exportJWK(keys.publicKey);
    assert.throws(
      () =>
        new OidcClientAuthenticator({
          issuer: "https://identity.example/",
          audience: "https://relay.example/mcp",
          jwksUri: "https://identity.example/jwks",
          scopes: ["tetherplane:access"],
          identity: {
            strategy: "subject",
            principalPrefix: "operator:",
            role: "owner",
          },
        }),
      /non-owner|owner role|operator:/i,
    );

    // OIDC custom prefix without explicit owner role is rejected as owner
    const oidcNoOwnerRole = new OidcClientAuthenticator(
      {
        issuer: "https://identity.example/",
        audience: "https://relay.example/mcp",
        jwksUri: "https://identity.example/jwks",
        scopes: ["tetherplane:access"],
        identity: {
          strategy: "subject",
          principalPrefix: "oidc:",
        },
      },
      createLocalJWKSet({ keys: [{ ...jwk, kid: "oidc-test" }] }),
    );
    const oidcJwt = await new SignJWT({
      iss: "https://identity.example/",
      aud: "https://relay.example/mcp",
      sub: "account-a",
      azp: "chatgpt",
      scope: "tetherplane:access",
      exp: Math.floor(Date.now() / 1000) + 300,
    })
      .setProtectedHeader({ alg: "RS256", kid: "oidc-test" })
      .sign(keys.privateKey);
    const oidcRelay = await RelayServer.create({
      allowInsecureLocalhost: true,
      authenticator: oidcNoOwnerRole,
    });
    try {
      const oidcAddr = await oidcRelay.listen({ host: "127.0.0.1", port: 0 });
      const res = await jsonReq(oidcAddr.httpUrl, "/portal/api/session", {
        method: "POST",
        token: oidcJwt,
      });
      assert.equal(res.status, 403);
    } finally {
      await oidcRelay.close();
    }
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-2: operators and non-owners cannot approve pairings, enumerate devices, revoke devices, or become owner_principal_id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-f2-devmgmt-"));
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
    authenticator: new StaticClientAuthenticator([
      {
        token: "owner-tok",
        accountId: "account-a",
        clientId: "owner-client",
        principalId: "human:account-a",
      },
      {
        token: "op-tok",
        accountId: "account-a",
        clientId: "op-client",
        principalId: "operator:assistant",
      },
      {
        token: "svc-tok",
        accountId: "account-a",
        clientId: "svc-client",
        principalId: "service:ci",
      },
    ]),
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    // Pair DeviceOne legitimately
    const deviceOneSecret = "device-one-f2-secret-32chars-12345";
    await pairDevice(address.httpUrl, "DeviceOne", deviceOneSecret, "owner-tok");

    // Start pairing for DeviceTwo
    const deviceTwoSecret = "device-two-f2-secret-32chars-12345";
    const startTwo = await jsonReq(address.httpUrl, "/pair/start", {
      method: "POST",
      body: {
        deviceId: "DeviceTwo",
        credentialHash: hashDeviceCredential(deviceTwoSecret),
      },
    });
    assert.equal(startTwo.status, 200);

    for (const nonOwnerTok of ["op-tok", "svc-tok"]) {
      const approveAttempt = await jsonReq(address.httpUrl, "/pair/approve", {
        method: "POST",
        token: nonOwnerTok,
        body: { userCode: startTwo.body.userCode },
      });
      assert.equal(approveAttempt.status, 403);

      const listAttempt = await jsonReq(address.httpUrl, "/devices", {
        method: "GET",
        token: nonOwnerTok,
      });
      assert.equal(listAttempt.status, 403);

      const revokeAttempt = await jsonReq(address.httpUrl, "/devices/DeviceOne/revoke", {
        method: "POST",
        token: nonOwnerTok,
        body: {},
      });
      assert.equal(revokeAttempt.status, 403);
    }

    // Verify DeviceTwo was not paired and DeviceOne remains active
    assert.equal(
      await relay.registry.authenticateDevice("DeviceTwo", deviceTwoSecret),
      null,
    );
    assert.equal(
      await relay.registry.authenticateDevice("DeviceOne", deviceOneSecret),
      "account-a",
    );

    // PolicyStore.ensureDevicePolicy directly rejects non-owner principals as owner_principal_id
    const registry = await DeviceRegistry.open();
    const policyStore = await PolicyStore.open({ registry });
    const pending = await registry.startPairing({
      deviceId: "DirectDevice",
      credentialHash: hashDeviceCredential("direct-device-secret-32chars-12345"),
    });
    const binding = await registry.approvePairing({
      accountId: "account-a",
      userCode: pending.userCode,
    });
    await assert.rejects(
      policyStore.ensureDevicePolicy(binding, "operator:evil"),
      /non-owner|owner principal|operator:/i,
    );
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-4(a,b,d): rejects operator/owner ID collisions, revoked device rollback, and non-canonical capabilities", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-f4-consistency-"));
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
    authenticator: new StaticClientAuthenticator([
      {
        token: "owner-tok",
        accountId: "account-a",
        clientId: "owner-client",
        principalId: "human:account-a",
      },
    ]),
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    await pairDevice(address.httpUrl, "Leno", "leno-f4-device-secret-32chars-12", "owner-tok");

    // F-4(a): Cannot overwrite/collide with owner principal ID via POST /portal/api/operators
    const collisionRes = await jsonReq(address.httpUrl, "/portal/api/operators", {
      method: "POST",
      token: "owner-tok",
      body: {
        principalId: "human:account-a",
        displayName: "Locked Owner",
        profileId: "lockdown",
      },
    });
    assert.equal(collisionRes.status, 400);
    const ownerEval = relay.policyStore.evaluateAndRecordInvocation({
      identity: {
        accountId: "account-a",
        clientId: "owner-client",
        principalId: "human:account-a",
      },
      deviceId: "Leno",
      capability: "device.status",
    });
    assert.equal(ownerEval.allowed, true);

    // F-4(d): Reject phantom/unknown capabilities in device policy, global apply, and operator CRUD
    for (const invalidCap of ["filesystem.delete", "phantom.op", '<img src=x>']) {
      const badDev = await jsonReq(address.httpUrl, "/portal/api/devices/Leno/policy", {
        method: "POST",
        token: "owner-tok",
        body: { revokeCapabilities: [invalidCap] },
      });
      assert.equal(badDev.status, 400);

      const badOp = await jsonReq(address.httpUrl, "/portal/api/operators", {
        method: "POST",
        token: "owner-tok",
        body: {
          principalId: "operator:valid",
          allowedCapabilities: [invalidCap],
        },
      });
      assert.equal(badOp.status, 400);

      const badGlobal = await jsonReq(address.httpUrl, "/portal/api/global/apply", {
        method: "POST",
        token: "owner-tok",
        body: {
          confirm: true,
          grantCapabilities: [invalidCap],
        },
      });
      assert.equal(badGlobal.status, 400);
    }

    // Valid canonical mutation reaches revision 2 before revocation
    const validMutation = await jsonReq(address.httpUrl, "/portal/api/devices/Leno/policy", {
      method: "POST",
      token: "owner-tok",
      body: { revokeCapabilities: ["process.terminate"], reason: "tighten" },
    });
    assert.equal(validMutation.status, 200);

    // F-4(b): Revoke Leno and verify rollback is denied (HTTP 403 and PolicyStore throws)
    const revokeRes = await jsonReq(address.httpUrl, "/devices/Leno/revoke", {
      method: "POST",
      token: "owner-tok",
      body: {},
    });
    assert.equal(revokeRes.status, 200);

    const rollbackRes = await jsonReq(address.httpUrl, "/portal/api/rollback", {
      method: "POST",
      token: "owner-tok",
      body: { deviceId: "Leno", targetRevision: 1, reason: "should fail" },
    });
    assert.equal(rollbackRes.status, 403);

    await assert.rejects(
      relay.policyStore.rollbackDevicePolicy({
        accountId: "account-a",
        actorPrincipalId: "human:account-a",
        deviceId: "Leno",
        targetRevision: 1,
      }),
      /not authorized|revoked/i,
    );
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-5: DeviceRegistry evicts expired pairings and enforces bounded queue; PolicyStore caps in-memory audit history", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-f5-bounds-"));
  try {
    const registry = await DeviceRegistry.open({
      pairingTtlMs: 30,
      maxPendingPairings: 3,
    });
    const secret = hashDeviceCredential("f5-device-secret-32-chars-minimum");

    const p1 = await registry.startPairing({ deviceId: "ExpDev1", credentialHash: secret });
    await registry.startPairing({ deviceId: "ExpDev2", credentialHash: secret });
    assert.equal(registry.pendingPairingCount(), 2);

    // Wait for initial entries to expire, then add 3 new entries up to cap 3
    await new Promise((r) => setTimeout(r, 45));
    const p3 = await registry.startPairing({ deviceId: "LiveDev1", credentialHash: secret });
    await registry.startPairing({ deviceId: "LiveDev2", credentialHash: secret });
    await registry.startPairing({ deviceId: "LiveDev3", credentialHash: secret });
    assert.equal(
      registry.pendingPairingCount(),
      3,
      "expired entries must be purged proactively on insert",
    );

    // Expired p1 is gone; adding a 4th non-expired entry exceeds capacity
    await assert.rejects(
      registry.approvePairing({ accountId: "account-a", userCode: p1.userCode }),
      /expired|invalid/i,
    );
    await assert.rejects(
      registry.startPairing({ deviceId: "OverflowDev", credentialHash: secret }),
      /capacity|full|too many/i,
    );

    // Approving p3 frees one slot cleanly
    const binding = await registry.approvePairing({
      accountId: "account-a",
      userCode: p3.userCode,
    });
    assert.equal(registry.pendingPairingCount(), 2);

    // Bounded in-memory audit history on PolicyStore
    const policyStore = await PolicyStore.open({
      registry,
      stateFile: path.join(dir, "devices.json"),
      maxAuditHistory: 5,
    });
    await policyStore.ensureDevicePolicy(binding);
    for (let i = 0; i < 7; i += 1) {
      await policyStore.updateDevicePolicy({
        accountId: "account-a",
        actorPrincipalId: "human:account-a",
        deviceId: "LiveDev1",
        mutation: {
          reason: `bounded audit step ${i}`,
          ...(i % 2 === 0 ? { revokeFamilies: ["desktop"] } : { grantFamilies: ["desktop"] }),
        },
      });
    }
    const events = policyStore.listAuditEvents("account-a");
    assert.equal(
      events.length,
      5,
      "PolicyStore must keep only the newest maxAuditHistory events in memory",
    );
    assert.equal(events[0]!.revision, 8);
    assert.equal(events[4]!.revision, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-5: rate limits /pair/start, /pair/approve, and /portal/api/session with 429 + Retry-After", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-f5-ratelimit-"));
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
    authenticator: new StaticClientAuthenticator([
      {
        token: "owner-tok",
        accountId: "account-a",
        clientId: "owner-client",
        principalId: "human:account-a",
      },
    ]),
    maxPendingPairings: 2,
    rateLimits: {
      pairStart: { maxRequests: 2, windowMs: 60_000 },
      pairApprove: { maxRequests: 2, windowMs: 60_000 },
      portalSession: { maxRequests: 2, windowMs: 60_000 },
    },
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const credHash = hashDeviceCredential("f5-rate-limit-device-secret-32ch");

  try {
    // 1. /pair/start rate limited on 3rd call
    const s1 = await fetch(`${address.httpUrl}/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "RateDev1", credentialHash: credHash }),
    });
    assert.equal(s1.status, 200);
    const s1Body = (await s1.json()) as { userCode: string };

    const s2 = await fetch(`${address.httpUrl}/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "RateDev2", credentialHash: credHash }),
    });
    assert.equal(s2.status, 200);

    const s3 = await fetch(`${address.httpUrl}/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "RateDev3", credentialHash: credHash }),
    });
    assert.equal(s3.status, 429);
    assert.ok(Number(s3.headers.get("retry-after")) >= 1);

    // 2. /pair/approve rate limited on 3rd attempt (protects 32-bit userCode)
    const a1 = await fetch(`${address.httpUrl}/pair/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer owner-tok",
      },
      body: JSON.stringify({ userCode: "0000-0000" }),
    });
    assert.equal(a1.status, 400);

    const a2 = await fetch(`${address.httpUrl}/pair/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer owner-tok",
      },
      body: JSON.stringify({ userCode: s1Body.userCode }),
    });
    assert.equal(a2.status, 200);

    const a3 = await fetch(`${address.httpUrl}/pair/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer owner-tok",
      },
      body: JSON.stringify({ userCode: "0000-0001" }),
    });
    assert.equal(a3.status, 429);
    assert.ok(Number(a3.headers.get("retry-after")) >= 1);

    // 3. /portal/api/session rate limited against bearer brute force
    const l1 = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-1" },
    });
    assert.equal(l1.status, 401);

    const l2 = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-2" },
    });
    assert.equal(l2.status, 401);

    const l3 = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: { authorization: "Bearer owner-tok" },
    });
    assert.equal(l3.status, 429);
    assert.ok(Number(l3.headers.get("retry-after")) >= 1);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-5: HTTP /pair/start returns 429 + Retry-After when pending pairing queue reaches maxPendingPairings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-f5-cap-http-"));
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
    authenticator: new StaticClientAuthenticator([
      {
        token: "owner-tok",
        accountId: "account-a",
        clientId: "owner-client",
        principalId: "human:account-a",
      },
    ]),
    maxPendingPairings: 1,
    rateLimits: {
      pairStart: { maxRequests: 10, windowMs: 60_000 },
    },
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const credHash = hashDeviceCredential("f5-capacity-http-device-secret-32");

  try {
    const first = await fetch(`${address.httpUrl}/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "CapDev1", credentialHash: credHash }),
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${address.httpUrl}/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "CapDev2", credentialHash: credHash }),
    });
    assert.equal(second.status, 429);
    assert.ok(Number(second.headers.get("retry-after")) >= 1);
    const errBody = (await second.json()) as { error?: { code?: string } };
    assert.equal(errBody.error?.code, "rate_limited");
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-7: preserves universal defaults while documenting destructive auto-approval, human coexistence, and lockdown restore semantics", async () => {
  const { renderControlPortalPage } = await import("../src/portal/portal-ui.ts");
  const { html } = renderControlPortalPage();

  assert.match(html, /Grant Universal/i);
  assert.match(html, /Lift Emergency Lockdown/i);
  assert.match(html, /human-origin process termination/i);
  assert.match(html, /unshared human tabs\/windows/i);
  assert.match(html, /Recoverable Snapshots/i);
  assert.match(html, /restores baseline Universal Access/i);

  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-f7-copy-"));
  const relay = await RelayServer.create({
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
    authenticator: new StaticClientAuthenticator([
      {
        token: "owner-tok",
        accountId: "account-a",
        clientId: "owner-client",
        principalId: "human:account-a",
      },
    ]),
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  try {
    await pairDevice(address.httpUrl, "Leno", "leno-f7-device-secret-32chars-12", "owner-tok");
    const overview = await jsonReq(address.httpUrl, "/portal/api/overview", {
      method: "GET",
      token: "owner-tok",
    });
    assert.equal(overview.status, 200);
    const profiles = overview.body.profiles as Array<{ id: string; description: string }>;
    const universalProfile = profiles.find((p) => p.id === "universal");
    assert.ok(universalProfile);
    assert.match(universalProfile.description, /human-origin process termination/i);
    assert.match(universalProfile.description, /destructive/i);
    assert.equal(overview.body.devices[0]?.policy?.owner_policy?.allow_destructive, true);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});
