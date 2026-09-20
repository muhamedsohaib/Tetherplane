import assert from "node:assert/strict";
import test from "node:test";

import type {
  InvocationEnvelope,
  ResultEnvelope,
} from "@tetherplane/protocol";

import {
  DeviceRegistry,
  hashDeviceCredential,
} from "../src/devices/registry.ts";
import {
  DeviceRouter,
  type DeviceConnectionHandle,
  type RelayToDeviceMessage,
} from "../src/routing/device-router.ts";

const identityA = {
  accountId: "account-a",
  clientId: "client-a",
  principalId: "human:account-a",
};
const identityB = {
  accountId: "account-b",
  clientId: "client-b",
  principalId: "human:account-b",
};

test("router injects authenticated provenance and correlates concurrent results", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const sent: RelayToDeviceMessage[] = [];
  const connection = router.connectDevice({
    accountId: "account-a",
    deviceId: "Leno",
    send: async (message) => {
      sent.push(message);
    },
  });

  const firstInvocation = invocation(
    "req-1",
    "filesystem.read",
    "Leno",
  );
  const secondInvocation = invocation(
    "req-2",
    "device.status",
    "Leno",
  );

  const firstPromise = router.call(identityA, firstInvocation);
  const secondPromise = router.call(identityA, secondInvocation);
  await until(() => sent.length === 2);

  assert.equal(sent[0]?.type, "invoke");
  assert.equal(sent[0]?.invocation.principal_id, "human:account-a");
  assert.deepEqual(sent[0]?.invocation.actor, {
    id: "client-a",
    kind: "ai_client",
  });

  connection.receive(
    resultMessage(sent[1]!, success(secondInvocation, { order: 2 })),
  );
  connection.receive(
    resultMessage(sent[0]!, success(firstInvocation, { order: 1 })),
  );

  assert.deepEqual((await firstPromise).data, { order: 1 });
  assert.deepEqual((await secondPromise).data, { order: 2 });
});

test("cross-account and unknown-device routing fail closed without touching a device", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 250 });
  let sends = 0;
  router.connectDevice({
    accountId: "account-a",
    deviceId: "Leno",
    send: async () => {
      sends += 1;
    },
  });

  const crossAccount = await router.call(
    identityB,
    invocation("req-cross", "device.status", "Leno"),
  );
  assert.equal(crossAccount.status, "error");
  assert.equal(crossAccount.error?.code, "permission_denied");

  const unknown = await router.call(
    identityA,
    invocation("req-missing", "device.status", "Surface"),
  );
  assert.equal(unknown.status, "error");
  assert.equal(unknown.error?.code, "capability_unavailable");
  assert.equal(sends, 0);
});

test("disconnect fails the in-flight call and reconnect never replays it", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const firstSent: RelayToDeviceMessage[] = [];
  const firstConnection = router.connectDevice({
    accountId: "account-a",
    deviceId: "Leno",
    send: async (message) => {
      firstSent.push(message);
    },
  });

  const pending = router.call(
    identityA,
    invocation("req-disconnect", "process.run", "Leno"),
  );
  await until(() => firstSent.length === 1);
  firstConnection.disconnect();

  const disconnected = await pending;
  assert.equal(disconnected.status, "error");
  assert.equal(disconnected.error?.code, "disconnected");
  assert.equal(firstSent.length, 1);

  const secondSent: RelayToDeviceMessage[] = [];
  const secondConnection = router.connectDevice({
    accountId: "account-a",
    deviceId: "Leno",
    send: async (message) => {
      secondSent.push(message);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(secondSent.length, 0);

  const retryInvocation = invocation(
    "req-retry",
    "process.run",
    "Leno",
  );
  retryInvocation.idempotency_key = "idem-remote-1";
  const retry = router.call(identityA, retryInvocation);
  await until(() => secondSent.length === 1);
  secondConnection.receive(
    resultMessage(
      secondSent[0]!,
      success(retryInvocation, { replay_safe: true }),
    ),
  );
  assert.equal((await retry).status, "success");
  assert.equal(secondSent.length, 1);
});

async function pairedRegistry(): Promise<DeviceRegistry> {
  const registry = await DeviceRegistry.open();
  const pending = await registry.startPairing({
    deviceId: "Leno",
    credentialHash: hashDeviceCredential(
      "device-secret-for-routing-tests",
    ),
  });
  await registry.approvePairing({
    accountId: "account-a",
    userCode: pending.userCode,
  });
  return registry;
}

function invocation(
  requestId: string,
  capability: string,
  deviceId: string | null,
): InvocationEnvelope {
  return {
    protocol_version: "1.0",
    request_id: requestId,
    principal_id: "spoofed:principal",
    device_id: deviceId,
    job_id: null,
    capability,
    arguments: {},
    actor: { id: "spoofed-client", kind: "ai_client" },
    session_id: null,
    response_mode: "compact",
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
}

function success(
  invocationValue: InvocationEnvelope,
  data: Record<string, unknown>,
): ResultEnvelope {
  return {
    protocol_version: "1.0",
    request_id: invocationValue.request_id,
    status: "success",
    data,
    delta: null,
    error: null,
    verification: "not_applicable",
    continuation: null,
    policy: null,
    timing: { duration_ms: 1 },
  };
}

function resultMessage(
  request: RelayToDeviceMessage,
  result: ResultEnvelope,
) {
  return {
    type: "result" as const,
    routeId: request.routeId,
    result,
  };
}

async function until(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for routing state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

void (null as DeviceConnectionHandle | null);
