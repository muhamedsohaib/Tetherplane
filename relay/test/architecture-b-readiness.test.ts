import assert from "node:assert/strict";
import test from "node:test";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";
import { PolicyStore } from "../src/policy/policy-store.ts";

async function overview(capabilities: Record<string, unknown>) {
  const registry = await DeviceRegistry.open();
  const pending = await registry.startPairing({
    deviceId: "fixture-device",
    credentialHash: hashDeviceCredential("fixture-device-secret-not-production"),
  });
  const binding = await registry.approvePairing({accountId: "fixture-account", userCode: pending.userCode});
  const store = await PolicyStore.open({registry});
  store.setSyncHooks({
    pushPolicy: async () => true,
    isOnline: () => true,
    connectionEvidence: () => ({status: null, capabilities, appliedRevision: 1}),
  });
  const record = await store.ensureDevicePolicy(binding);
  await store.handleDeviceHello({deviceId: binding.deviceId, accountId: binding.accountId, appliedPolicyRevision: 1, capabilities});
  return store.formatDeviceOverview(binding, record) as {
    confirmedByDevice: boolean;
    familySummaries: Array<{family: string; providerState: string; activeOperations: string[]}>;
    unavailableCapabilities: Array<{name: string; status: string; reason: string}>;
  };
}

function browser(result: Awaited<ReturnType<typeof overview>>) {
  const family = result.familySummaries.find((f) => f.family === "browser");
  assert.ok(family);
  return family;
}

function legacyBrowser() {
  return {
    namespace: "browser", tool_family: "browser", available: true,
    available_operations: ["pages", "snapshot"],
    granted_operations: ["pages", "snapshot"],
  };
}
function newBrowser(state: string, observed_at: number, operations = ["pages"]) {
  return {namespace: "browser", state, observed_at, reason: null, operations};
}
const familyReady = {browser: {family: "browser", available: true, available_operations: ["browser.pages", "browser.snapshot"]}};

test("S3 readiness maps exact provider namespace and operation list without inventing access", async () => {
  const result = await overview({providers: [newBrowser("ready", Date.now())]});
  assert.equal(result.confirmedByDevice, true);
  assert.equal(browser(result).providerState, "available");
  assert.deepEqual(browser(result).activeOperations, ["browser.pages"]);
});

test("legacy boolean readiness retains compatibility", async () => {
  const result = await overview({providers: [legacyBrowser()]});
  assert.equal(browser(result).providerState, "available");
  assert.deepEqual(browser(result).activeOperations, ["browser.pages", "browser.snapshot"]);
});

test("mixed payload cannot override degraded or unauthorized provider state", async () => {
  for (const state of ["degraded", "disconnected", "unauthorized", "recovering"]) {
    const result = await overview({providers: [{...legacyBrowser(), ...newBrowser(state, Date.now()), reason: "fixture observation"}], tool_families: familyReady});
    assert.deepEqual(browser(result).activeOperations, [], state);
    assert.equal(result.unavailableCapabilities.find((p) => p.name === "browser")?.status, state);
  }
});

test("stale, missing, future, or unknown S3 observations cannot be promoted by legacy ready flags", async () => {
  const inputs = [
    newBrowser("ready", Date.now() - 31_000),
    newBrowser("ready", Date.now() + 60_000),
    newBrowser("unexpected", Date.now()),
    {namespace: "browser", state: "ready", operations: ["pages"]},
  ];
  for (const input of inputs) {
    const result = await overview({providers: [{...legacyBrowser(), ...input}], tool_families: familyReady});
    assert.deepEqual(browser(result).activeOperations, []);
    assert.equal(browser(result).providerState, "unknown");
  }
});

test("S3 operation list narrows legacy operation and grant evidence", async () => {
  const result = await overview({providers: [{...legacyBrowser(), ...newBrowser("ready", Date.now(), ["pages", "noncanonical"])}], tool_families: familyReady});
  assert.deepEqual(browser(result).activeOperations, ["browser.pages"]);
});

test("explicit negative legacy evidence still wins over new readiness", async () => {
  const result = await overview({providers: [{...newBrowser("ready", Date.now()), tool_family: "browser", available: false}], tool_families: familyReady});
  assert.deepEqual(browser(result).activeOperations, []);
});

test("malformed or absent S3 operation inventory never inherits legacy family operations", async () => {
  for (const operations of [undefined, ["pages", 42]]) {
    const result = await overview({providers: [{...legacyBrowser(), ...newBrowser("ready", Date.now()), operations}], tool_families: familyReady});
    assert.deepEqual(browser(result).activeOperations, []);
  }
});