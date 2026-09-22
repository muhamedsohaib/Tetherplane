import assert from "node:assert/strict";
import test from "node:test";

import { BridgeLoopCoordinator } from "../src/bridge-loop.ts";

test("bridge loop does not start without pairing config", async () => {
  let runs = 0;

  const coordinator = new BridgeLoopCoordinator({
    hasConfig: async () => false,
    runLoop: async () => {
      runs += 1;
    },
  });

  assert.equal(await coordinator.ensureRunning(), false);
  assert.equal(runs, 0);
});

test("bridge loop starts exactly once when concurrent reconnect requests arrive", async () => {
  let runs = 0;
  let release: (() => void) | undefined;

  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  const coordinator = new BridgeLoopCoordinator({
    hasConfig: async () => true,
    runLoop: async () => {
      runs += 1;
      await pending;
    },
  });

  const results = await Promise.all([
    coordinator.ensureRunning(),
    coordinator.ensureRunning(),
    coordinator.ensureRunning(),
  ]);

  assert.deepEqual(results, [true, true, true]);
  assert.equal(runs, 1);

  release?.();
});