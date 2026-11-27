import assert from "node:assert/strict";
import { mkdtemp, rm, rmdir, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

// ---- S4: Desired/Effective/Acknowledged policy sync ----

function connectFake(
  router: DeviceRouter,
  sent: RelayToDeviceMessage[],
): DeviceConnectionHandle {
  return router.connectDevice({
    accountId: "account-a",
    deviceId: "Leno",
    send: async (message) => {
      sent.push(message);
    },
  });
}

function policyAck(
  version: number,
  status: "applied" | "rejected",
  appliedCapabilities: string[],
  reason?: string,
) {
  return {
    type: "policy_ack" as const,
    version,
    status,
    appliedCapabilities,
    ...(reason === undefined ? {} : { reason }),
  };
}

test("owner setDesired pushes versioned policy to the online device", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const sent: RelayToDeviceMessage[] = [];
  connectFake(router, sent);

  const first = await router.setDesiredPolicy("account-a", "Leno", [
    "device.status",
  ]);
  assert.deepEqual(first, { version: 1, pushed: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "policy",
    version: 1,
    allowedCapabilities: ["device.status"],
  });

  const second = await router.setDesiredPolicy("account-a", "Leno", [
    "device.status",
    "browser.pages",
  ]);
  assert.equal(second.version, 2);
  const sync = router.getPolicySync("account-a", "Leno")!;
  assert.equal(sync.desiredVersion, 2);
  assert.equal(sync.acknowledgedVersion, 0);
  assert.equal(sync.pending, true);
});

test("setDesired on an offline device stores without push", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });

  const set = await router.setDesiredPolicy("account-a", "Leno", ["device.status"]);
  assert.deepEqual(set, { version: 1, pushed: false });
  const sync = router.getPolicySync("account-a", "Leno")!;
  assert.equal(sync.online, false);
  assert.equal(sync.pending, true);

  const sent: RelayToDeviceMessage[] = [];
  connectFake(router, sent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, "policy");
});

test("applied ack converges with the applied set recorded", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const sent: RelayToDeviceMessage[] = [];
  const connection = connectFake(router, sent);
  await router.setDesiredPolicy("account-a", "Leno", ["device.status"]);

  connection.receive(policyAck(1, "applied", ["device.status"]));
  const sync = router.getPolicySync("account-a", "Leno")!;
  assert.equal(sync.acknowledgedVersion, 1);
  assert.equal(sync.lastStatus, "applied");
  assert.deepEqual(sync.appliedCapabilities, ["device.status"]);
  assert.equal(sync.pending, false);
});

test("rejected ack converges with status and reason preserved", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const sent: RelayToDeviceMessage[] = [];
  const connection = connectFake(router, sent);
  await router.setDesiredPolicy("account-a", "Leno", ["device.status", "process.run"]);

  connection.receive(
    policyAck(1, "rejected", ["device.status"], "exceeds ceiling"),
  );
  const sync = router.getPolicySync("account-a", "Leno")!;
  assert.equal(sync.acknowledgedVersion, 1);
  assert.equal(sync.lastStatus, "rejected");
  assert.equal(sync.lastReason, "exceeds ceiling");
  assert.deepEqual(sync.appliedCapabilities, ["device.status"]);
  assert.equal(sync.pending, false);
});

test("stale and future acks can never regress acknowledged state", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const sent: RelayToDeviceMessage[] = [];
  const connection = connectFake(router, sent);
  await router.setDesiredPolicy("account-a", "Leno", ["device.status"]);
  await router.setDesiredPolicy("account-a", "Leno", ["device.status", "browser.pages"]);
  connection.receive(policyAck(2, "applied", ["device.status", "browser.pages"]));

  connection.receive(policyAck(1, "applied", ["device.status"]));
  let sync = router.getPolicySync("account-a", "Leno")!;
  assert.equal(sync.acknowledgedVersion, 2);
  assert.deepEqual(sync.appliedCapabilities, ["device.status", "browser.pages"]);

  connection.receive(policyAck(9, "applied", ["device.status"]));
  sync = router.getPolicySync("account-a", "Leno")!;
  assert.equal(sync.acknowledgedVersion, 2);
  assert.equal(sync.pending, false);
});

test("reconnect resets ack state and re-pushes current desired", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const firstSent: RelayToDeviceMessage[] = [];
  const first = connectFake(router, firstSent);
  await router.setDesiredPolicy("account-a", "Leno", ["device.status"]);
  first.receive(policyAck(1, "applied", ["device.status"]));
  assert.equal(router.getPolicySync("account-a", "Leno")!.pending, false);
  first.disconnect();

  const secondSent: RelayToDeviceMessage[] = [];
  const second = connectFake(router, secondSent);
  assert.equal(secondSent.length, 1);
  assert.deepEqual(secondSent[0], {
    type: "policy",
    version: 1,
    allowedCapabilities: ["device.status"],
  });
  let sync = router.getPolicySync("account-a", "Leno")!;
  assert.equal(sync.acknowledgedVersion, 0);
  assert.equal(sync.pending, true);

  second.receive(policyAck(1, "applied", ["device.status"]));
  sync = router.getPolicySync("account-a", "Leno")!;
  assert.equal(sync.pending, false);
});

test("stale-generation ack is dropped and cannot touch live state", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const firstSent: RelayToDeviceMessage[] = [];
  const first = connectFake(router, firstSent);
  await router.setDesiredPolicy("account-a", "Leno", ["device.status"]);

  const secondSent: RelayToDeviceMessage[] = [];
  connectFake(router, secondSent);
  // Old socket's late ack for the same version must not resolve the
  // new generation's pending state.
  first.receive(policyAck(1, "applied", ["device.status"]));
  const sync = router.getPolicySync("account-a", "Leno")!;
  assert.equal(sync.acknowledgedVersion, 0);
  assert.equal(sync.pending, true);
});

test("rapid concurrent sets deliver latest only", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  await router.setDesiredPolicy("account-a", "Leno", ["device.status"]);
  await router.setDesiredPolicy("account-a", "Leno", ["device.status", "browser.pages"]);

  const sent: RelayToDeviceMessage[] = [];
  const connection = connectFake(router, sent);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "policy",
    version: 2,
    allowedCapabilities: ["device.status", "browser.pages"],
  });
  connection.receive(
    policyAck(2, "applied", ["device.status", "browser.pages"]),
  );
  assert.equal(router.getPolicySync("account-a", "Leno")!.pending, false);
});

test("policy sync fails closed on unknown, unowned, and revoked devices", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  await assert.rejects(() =>
    router.setDesiredPolicy("account-a", "ghost", ["device.status"]),
  );
  await assert.rejects(() =>
    router.setDesiredPolicy("account-b", "Leno", ["device.status"]),
  );
  assert.equal(router.getPolicySync("account-a", "ghost"), null);
  assert.equal(router.getPolicySync("account-b", "Leno"), null);

  await registry.revokeDevice({ accountId: "account-a", deviceId: "Leno" });
  await assert.rejects(() =>
    router.setDesiredPolicy("account-a", "Leno", ["device.status"]),
  );
});

test("policy sync validates capability payloads", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const cases: Array<[string, unknown]> = [
    ["non-array", "device.status"],
    ["blank entry", [""]],
    ["whitespace entry", ["   "]],
    ["oversized entry", ["x".repeat(257)]],
    ["oversized list", Array.from({ length: 1025 }, (_, index) => `cap.${index}`)],
  ];
  for (const [name, caps] of cases) {
    await assert.rejects(
      router.setDesiredPolicy("account-a", "Leno", caps as string[]),
      /allowedCapabilities/,
      `${name} must be rejected with a validation error`,
    );
  }
});

test("policy fleet overview covers offline and unconfigured devices", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const sent: RelayToDeviceMessage[] = [];
  connectFake(router, sent);
  await router.setDesiredPolicy("account-a", "Leno", ["device.status"]);

  const fleet = router.listPolicySync("account-a");
  assert.equal(fleet.length, 1);
  assert.equal(fleet[0]?.deviceId, "Leno");
  assert.equal(fleet[0]?.online, true);
  assert.equal(fleet[0]?.pending, true);
  assert.deepEqual(router.listPolicySync("account-b"), []);
});

// ---- S4 closure: persistence, hold-while-pending, storage failure ----

test("desired policy survives relay restart and re-pushes on reconnect", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-policy-restart-"));
  try {
    const stateFile = path.join(dir, "devices.json");
    const registry1 = await DeviceRegistry.open({ stateFile });
    const pending = await registry1.startPairing({
      deviceId: "Leno",
      credentialHash: hashDeviceCredential("device-secret-for-restart-test"),
    });
    await registry1.approvePairing({ accountId: "account-a", userCode: pending.userCode });
    const router1 = new DeviceRouter({ registry: registry1, timeoutMs: 2_000 });
    const sent1: RelayToDeviceMessage[] = [];
    const first = router1.connectDevice({
      accountId: "account-a",
      deviceId: "Leno",
      send: async (message) => {
        sent1.push(message);
      },
    });
    await router1.setDesiredPolicy("account-a", "Leno", ["device.status"]);
    first.receive(policyAck(1, "applied", ["device.status"]));
    assert.equal(router1.getPolicySync("account-a", "Leno")!.pending, false);

    // Simulate a relay restart: fresh registry reloaded from the same
    // file plus a fresh router. Desired persists; acks do not.
    const registry2 = await DeviceRegistry.open({ stateFile });
    const router2 = new DeviceRouter({ registry: registry2, timeoutMs: 2_000 });
    const restored = router2.getPolicySync("account-a", "Leno")!;
    assert.equal(restored.desiredVersion, 1);
    assert.deepEqual(restored.desiredCapabilities, ["device.status"]);
    assert.equal(restored.acknowledgedVersion, 0);
    assert.equal(restored.online, false);
    assert.equal(restored.pending, true);

    const sent2: RelayToDeviceMessage[] = [];
    const second = router2.connectDevice({
      accountId: "account-a",
      deviceId: "Leno",
      send: async (message) => {
        sent2.push(message);
      },
    });
    assert.equal(sent2.length, 1);
    assert.deepEqual(sent2[0], {
      type: "policy",
      version: 1,
      allowedCapabilities: ["device.status"],
    });
    second.receive(policyAck(1, "applied", ["device.status"]));
    assert.equal(router2.getPolicySync("account-a", "Leno")!.pending, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("routing holds while sync pending and resumes after ack", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const sent: RelayToDeviceMessage[] = [];
  const connection = connectFake(router, sent);
  await router.setDesiredPolicy("account-a", "Leno", ["device.status"]);

  const held = router.call(identityA, invocation("req-held", "device.status", "Leno"));
  const heldResult = await held;
  assert.equal(heldResult.status, "error");
  assert.equal(heldResult.error?.code, "timeout");
  assert.match(heldResult.error?.message ?? "", /sync pending/);
  assert.equal(
    sent.filter((message) => message.type === "invoke").length,
    0,
    "held call must never be routed to the device",
  );

  connection.receive(policyAck(1, "applied", ["device.status"]));
  const released = router.call(identityA, invocation("req-free", "device.status", "Leno"));
  await until(() => sent.some((message) => message.type === "invoke"));
  const invoke = sent.find((message) => message.type === "invoke")!;
  connection.receive(resultMessage(invoke, success(invocation("req-free", "device.status", "Leno"), {})));
  assert.equal((await released).status, "success");
});

test("failed push reports unpushed and reconnect recovers", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  router.connectDevice({
    accountId: "account-a",
    deviceId: "Leno",
    send: async () => {
      throw new Error("socket dead");
    },
  });
  const set = await router.setDesiredPolicy("account-a", "Leno", ["device.status"]);
  assert.deepEqual(set, { version: 1, pushed: false });
  assert.equal(router.getPolicySync("account-a", "Leno")!.pending, true);

  const sent: RelayToDeviceMessage[] = [];
  const connection = connectFake(router, sent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, "policy");
  connection.receive(policyAck(1, "applied", ["device.status"]));
  assert.equal(router.getPolicySync("account-a", "Leno")!.pending, false);
});

test("missing configuration is distinct from converged-open", async () => {
  const registry = await pairedRegistry();
  const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
  const sent: RelayToDeviceMessage[] = [];
  const connection = connectFake(router, sent);

  const missing = router.getPolicySync("account-a", "Leno")!;
  assert.equal(missing.desiredVersion, 0);
  assert.equal(missing.pending, false);
  assert.equal(missing.lastStatus, null);

  await router.setDesiredPolicy("account-a", "Leno", ["device.status", "browser.pages"]);
  connection.receive(policyAck(1, "applied", ["device.status", "browser.pages"]));
  const open = router.getPolicySync("account-a", "Leno")!;
  assert.equal(open.desiredVersion, 1);
  assert.equal(open.pending, false);
  assert.equal(open.lastStatus, "applied");
  assert.deepEqual(open.appliedCapabilities, ["device.status", "browser.pages"]);
});

test("unavailable policy storage rolls back the version", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-policy-broken-"));
  try {
    const stateFile = path.join(dir, "devices.json");
    const registry = await DeviceRegistry.open({ stateFile });
    const pending = await registry.startPairing({
      deviceId: "Leno",
      credentialHash: hashDeviceCredential("device-secret-for-broken-store"),
    });
    await registry.approvePairing({ accountId: "account-a", userCode: pending.userCode });
    const router = new DeviceRouter({ registry, timeoutMs: 2_000 });
    // Block the registry's atomic-rename temp path with a directory:
    // persistence fails deterministically (EISDIR, even for root).
    await mkdir(`${stateFile}.tmp-${process.pid}`);
    try {
      await assert.rejects(
        router.setDesiredPolicy("account-a", "Leno", ["device.status"]),
      );
    } finally {
      await rmdir(`${stateFile}.tmp-${process.pid}`);
    }
    const sync = router.getPolicySync("account-a", "Leno")!;
    assert.equal(sync.desiredVersion, 0, "failed persist must roll back memory");
    assert.equal(sync.pending, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  if (request.type !== "invoke") {
    throw new Error("resultMessage needs an invoke request");
  }
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
