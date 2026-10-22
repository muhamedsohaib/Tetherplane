import assert from "node:assert/strict";
import test from "node:test";

import type { InvocationEnvelope, ResultEnvelope } from "@tetherplane/protocol";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";
import { DeviceRouter, type RelayToDeviceMessage } from "../src/routing/device-router.ts";

const identity = {
  accountId: "account-reconnect-test",
  clientId: "client-reconnect-test",
  principalId: "human:reconnect-test",
};

async function registryForTest(): Promise<DeviceRegistry> {
  const registry = await DeviceRegistry.open();
  const pending = await registry.startPairing({
    deviceId: "Leno",
    credentialHash: hashDeviceCredential("synthetic-regression-secret-only"),
  });
  await registry.approvePairing({
    accountId: identity.accountId,
    userCode: pending.userCode,
  });
  return registry;
}

function invocation(id: string, capability = "device.status"): InvocationEnvelope {
  return {
    protocol_version: "1.0",
    request_id: id,
    principal_id: "untrusted:incoming",
    device_id: "Leno",
    job_id: null,
    capability,
    arguments: {},
    actor: { id: "incoming-client", kind: "ai_client" },
    session_id: null,
    response_mode: "compact",
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
}

function success(requestId: string): ResultEnvelope {
  return {
    protocol_version: "1.0",
    request_id: requestId,
    status: "success",
    data: { synthetic: true },
    delta: null,
    error: null,
    verification: "not_applicable",
    continuation: null,
    policy: null,
    timing: { duration_ms: 0 },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const limit = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= limit) throw new Error("synthetic test timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("new authenticated connection survives stale predecessor disconnect", async () => {
  const router = new DeviceRouter({ registry: await registryForTest(), timeoutMs: 2000 });
  const old = router.connectDevice({
    accountId: identity.accountId,
    deviceId: "Leno",
    send: async () => {},
  });
  const messages: RelayToDeviceMessage[] = [];
  const current = router.connectDevice({
    accountId: identity.accountId,
    deviceId: "Leno",
    send: async (message) => { messages.push(message); },
  });
  old.disconnect();
  assert.equal(router.isOnline("Leno"), true);

  const request = invocation("new-generation-status");
  const pending = router.call(identity, request);
  await until(() => messages.length === 1);
  current.receive({ type: "result", routeId: messages[0]!.routeId, result: success(request.request_id) });
  assert.equal((await pending).status, "success");
});

test("stale generation result cannot satisfy pending request on new connection", async () => {
  const router = new DeviceRouter({ registry: await registryForTest(), timeoutMs: 2000 });
  const oldMessages: RelayToDeviceMessage[] = [];
  const old = router.connectDevice({
    accountId: identity.accountId,
    deviceId: "Leno",
    send: async (message) => { oldMessages.push(message); },
  });
  const first = router.call(identity, invocation("first-generation"));
  await until(() => oldMessages.length === 1);

  const newMessages: RelayToDeviceMessage[] = [];
  const current = router.connectDevice({
    accountId: identity.accountId,
    deviceId: "Leno",
    send: async (message) => { newMessages.push(message); },
  });
  assert.equal((await first).error?.code, "disconnected");

  const next = invocation("second-generation");
  const active = router.call(identity, next);
  await until(() => newMessages.length === 1);
  old.receive({ type: "result", routeId: newMessages[0]!.routeId, result: success(next.request_id) });
  old.disconnect();
  assert.equal(router.isOnline("Leno"), true);
  current.receive({ type: "result", routeId: newMessages[0]!.routeId, result: success(next.request_id) });
  assert.equal((await active).status, "success");
});

test("failed send returns disconnected; reconnect never retries mutation automatically", async () => {
  const router = new DeviceRouter({ registry: await registryForTest(), timeoutMs: 2000 });
  let attempted = 0;
  const old = router.connectDevice({
    accountId: identity.accountId,
    deviceId: "Leno",
    send: async () => {
      attempted++;
      throw new Error("synthetic network reset / TLS EOF boundary");
    },
  });
  const initial = invocation("nonreplayed-mutation", "process.run");
  initial.idempotency_key = "synthetic-idem";
  const result = await router.call(identity, initial);
  assert.equal(result.error?.code, "disconnected");
  assert.equal(attempted, 1);
  old.disconnect();

  let replacementSends = 0;
  router.connectDevice({
    accountId: identity.accountId,
    deviceId: "Leno",
    send: async () => { replacementSends++; },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(replacementSends, 0);
});
