import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import type { InvocationEnvelope, ResultEnvelope } from "@tetherplane/protocol";

import { OidcClientAuthenticator } from "../src/auth/oidc-auth.ts";
import type { ClientIdentity } from "../src/auth/static-auth.ts";
import { hashDeviceCredential } from "../src/devices/registry.ts";
import type { DeviceConnectionHandle } from "../src/routing/device-router.ts";
import { RelayServer } from "../src/server.ts";

// Synthetic, ephemeral OAuth material: no real client registrations, tokens,
// device keys, pairing state, owner principal or live service are contacted.
const subject = "qa-owner-subject";
const clientIds = {
  portal: "existing-owner-portal-qa",
  chatgpt: "existing-chatgpt-qa",
  unrelated: "other-client-qa",
} as const;
const audience = "https://relay.synthetic.example/mcp";
const issuer = "https://issuer.synthetic.example/";

function invocation(deviceId: string, capability: string, args: Record<string, unknown> = {}): InvocationEnvelope {
  return {
    protocol_version: "1.0",
    request_id: randomUUID(),
    device_id: deviceId,
    principal_id: "attacker-cannot-choose-principal",
    job_id: null,
    capability,
    arguments: args,
    actor: { id: "attacker-cannot-choose-actor", kind: "ai_client" },
    session_id: null,
    response_mode: "compact",
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
}

test("real signed OAuth identities enforce per-client/device presets, owner separation, revoke and rollback without registrations", async t => {
  const workdir = await mkdtemp(path.join(os.tmpdir(), "tp-owner-oidc-qa-"));
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  const auth = new OidcClientAuthenticator({
    issuer,
    audience,
    jwksUri: issuer + ".well-known/jwks.json",
    scopes: ["tetherplane:access"],
    identity: { strategy: "subject", principalPrefix: "human:" },
  }, createLocalJWKSet({ keys: [{ ...jwk, kid: "ephemeral-qa" }] }));

  async function token(clientId: string, subjectClaim = subject, scope = "tetherplane:access", aud = audience): Promise<string> {
    return new SignJWT({
      iss: issuer,
      aud,
      sub: subjectClaim,
      azp: clientId,
      scope,
      exp: Math.floor(Date.now() / 1000) + 300,
    }).setProtectedHeader({ alg: "RS256", kid: "ephemeral-qa" }).sign(keys.privateKey);
  }
  const ownerToken = await token(clientIds.portal);
  const chatToken = await token(clientIds.chatgpt);
  const unrelatedToken = await token(clientIds.unrelated);
  const wrongSubjectToken = await token(clientIds.portal, "another-account");
  const wrongScopeToken = await token(clientIds.portal, subject, "different:scope");
  const wrongAudienceToken = await token(clientIds.portal, subject, "tetherplane:access", "https://another.synthetic.example/mcp");

  const identity = async (jwt: string): Promise<ClientIdentity> => {
    const verified = await auth.authenticate(jwt);
    assert.ok(verified, "signed test identity must verify");
    return verified;
  };
  const owner = await identity(ownerToken);
  const chat = await identity(chatToken);
  const unrelated = await identity(unrelatedToken);
  assert.equal(owner.accountId, chat.accountId, "same signed user account");
  assert.equal(owner.principalId, chat.principalId, "same remote principal");
  assert.notEqual(owner.clientId, chat.clientId, "distinct registered client identifiers");
  assert.equal(await auth.authenticate(wrongScopeToken), null);
  assert.equal(await auth.authenticate(wrongAudienceToken), null);

  const stateFile = path.join(workdir, "owner-authority.json");
  const relay = await RelayServer.create({
    authenticator: auth,
    authority: { owner, stateFile },
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await relay.close();
    await rm(workdir, { recursive: true, force: true });
  });
  async function api(route: string, jwt: string | null = ownerToken, method = "GET", payload?: unknown) {
    const response = await fetch(address.httpUrl + route, {
      method,
      headers: {
        ...(jwt === null ? {} : { authorization: "Bearer " + jwt }),
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await response.text();
    return { status: response.status, data: body ? JSON.parse(body) : null };
  }

  assert.equal((await api("/authority", null)).status, 401);
  assert.equal((await api("/authority", chatToken)).status, 403);
  assert.equal((await api("/authority", unrelatedToken)).status, 403);
  assert.equal((await api("/authority", wrongSubjectToken)).status, 403);
  assert.equal((await api("/authority", wrongScopeToken)).status, 401);
  assert.equal((await api("/authority", wrongAudienceToken)).status, 401);
  assert.equal((await api("/authority", ownerToken)).status, 200);
  assert.equal((await api("/authority", ownerToken)).data.enabled, false);

  const handles = new Map<string, DeviceConnectionHandle>();
  const deliveries = new Map<string, number>();
  for (const deviceId of ["Leno", "Surface", "VAULTER"]) {
    const pending = await relay.registry.startPairing({
      deviceId,
      credentialHash: hashDeviceCredential("synthetic-credential-for-" + deviceId),
    });
    await relay.registry.approvePairing({ accountId: owner.accountId, userCode: pending.userCode });
    deliveries.set(deviceId, 0);
    const handle = relay.router.connectDevice({
      accountId: owner.accountId,
      deviceId,
      async send(message) {
        deliveries.set(deviceId, (deliveries.get(deviceId) ?? 0) + 1);
        const result: ResultEnvelope = {
          protocol_version: "1.0",
          request_id: message.invocation.request_id,
          status: "success",
          data: {
            synthetic: true,
            device: deviceId,
            principalId: message.invocation.principal_id,
            clientId: message.invocation.actor.id,
          },
          delta: null,
          error: null,
          policy: null,
          verification: "not_applicable",
          continuation: null,
          timing: { duration_ms: 1 },
        };
        queueMicrotask(() => handles.get(deviceId)?.receive({
          type: "result",
          routeId: message.routeId,
          result,
        }));
      },
    });
    handles.set(deviceId, handle);
  }

  // Unknown or unpaired RTX must not acquire a grant by name alone.
  const rtxGrant = [{ deviceId: "RTX", clientId: chat.clientId, principalId: chat.principalId, level: "observe" }];
  assert.equal((await api("/authority/grants", ownerToken, "PUT", { revision: 0, grants: rtxGrant })).status, 403);
  assert.equal((await api("/authority/grants", chatToken, "PUT", { revision: 0, grants: [] })).status, 403);

  const grants = [
    ...(["Leno", "Surface", "VAULTER"] as const).map(deviceId => ({
      deviceId, clientId: owner.clientId, principalId: owner.principalId, level: "observe",
    })),
    { deviceId: "Leno", clientId: chat.clientId, principalId: chat.principalId, level: "operate" },
    ...(["Surface", "VAULTER"] as const).map(deviceId => ({
      deviceId, clientId: chat.clientId, principalId: chat.principalId, level: "observe",
    })),
    { deviceId: "Surface", clientId: unrelated.clientId, principalId: unrelated.principalId, level: "blocked" },
  ];
  assert.equal((await api("/authority/grants", ownerToken, "PUT", { revision: 0, grants })).status, 200);
  assert.equal((await api("/authority/grants", ownerToken, "PUT", { revision: 0, grants: [] })).status, 409);

  async function call(id: ClientIdentity, device: string, capability: string, args: Record<string, unknown> = {}) {
    return relay.router.call(id, invocation(device, capability, args));
  }
  const legacy = await call(unrelated, "Leno", "device.status");
  assert.equal(legacy.status, "success", "unactivated grants must preserve legacy routing");

  assert.equal((await api("/authority/enforcement", chatToken, "POST", {
    revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS",
  })).status, 403);
  assert.equal((await api("/authority/enforcement", ownerToken, "POST", {
    revision: 1, enabled: true, confirmation: "YES",
  })).status, 400);
  assert.equal((await api("/authority/enforcement", ownerToken, "POST", {
    revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS",
  })).status, 200);

  const counter = () => [...deliveries.values()].reduce((sum, n) => sum + n, 0);
  async function expectDenied(id: ClientIdentity, device: string, capability: string, args: Record<string, unknown> = {}) {
    const before = counter();
    const reply = await call(id, device, capability, args);
    assert.equal(reply.status, "error");
    assert.equal(reply.error?.code, "permission_denied");
    assert.equal(reply.policy?.source, "relay.owner_device_authority");
    assert.equal(counter(), before, "denied request never dispatched to any device");
  }

  const lenoWrite = await call(chat, "Leno", "filesystem.write");
  assert.equal(lenoWrite.status, "success", "Operate permits a file operation at the relay gate only");
  assert.equal(lenoWrite.data?.clientId, chat.clientId, "untrusted actor label was replaced");
  assert.equal(lenoWrite.data?.principalId, chat.principalId, "untrusted principal label was replaced");
  for (const device of ["Surface", "VAULTER"]) {
    assert.equal((await call(chat, device, "device.status")).status, "success");
    await expectDenied(chat, device, "filesystem.write");
  }
  assert.equal((await call(owner, "Leno", "device.status")).status, "success");
  await expectDenied(owner, "Leno", "filesystem.write");
  await expectDenied(chat, "Leno", "process.run");
  await expectDenied(chat, "Leno", "process.input");
  await expectDenied(chat, "Leno", "batch.execute", {
    mode: "sequential",
    operations: [
      { capability: "filesystem.info", arguments: {} },
      { capability: "process.run", arguments: {} },
    ],
  });
  await expectDenied(unrelated, "Surface", "device.status");
  await expectDenied(unrelated, "Leno", "device.status");
  await expectDenied(unrelated, "VAULTER", "device.status");

  // Revocation drops grants and forbids same-name reuse, including while
  // this synthetic transport handle remains present.
  assert.equal((await api("/devices/Surface/revoke", chatToken, "POST", {})).status, 403);
  assert.equal((await api("/devices/Surface/revoke", ownerToken, "POST", {})).status, 200);
  assert.equal((await api("/authority", ownerToken)).data.grants.some((g: { deviceId: string }) => g.deviceId === "Surface"), false);
  assert.equal((await call(chat, "Surface", "device.status")).error?.code, "permission_denied");

  const snapshot = (await api("/authority", ownerToken)).data;
  assert.equal(snapshot.enabled, true);
  assert.equal((await api("/authority/enforcement", ownerToken, "POST", {
    revision: snapshot.revision, enabled: false, confirmation: "RESTORE LEGACY ACCESS",
  })).status, 200);
  assert.equal((await call(unrelated, "Leno", "device.status")).status, "success",
    "owner-confirmed legacy rollback restores prior relay behavior");
  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.enabled, false);
  assert.ok(!JSON.stringify(persisted).includes("Bearer "));
});
