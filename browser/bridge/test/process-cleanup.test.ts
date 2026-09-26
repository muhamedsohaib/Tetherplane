import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  stopOwnedChromiumProcesses,
} from "../src/process-cleanup.ts";

class StuckChild extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  killCalls = 0;
  unrefCalls = 0;

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  unref(): this {
    this.unrefCalls += 1;
    return this;
  }
}

test("failed Chromium launch escalates to process-tree cleanup and cannot pin Node forever", async () => {
  const child = new StuckChild();
  const forced: number[] = [];

  await stopOwnedChromiumProcesses(
    child as never,
    null,
    {
      isProcessAlive() {
        return true;
      },
      async waitForPidExit() {},
      async forceTerminateProcessTree(pid) {
        forced.push(pid);
      },
    },
  );

  assert.equal(child.killCalls, 1);
  assert.deepEqual(forced, [4242]);
  assert.equal(child.unrefCalls, 1);
});

test("Chromium cleanup does not force-kill a child that exits after graceful termination", async () => {
  const child = new StuckChild();
  let alive = true;
  const forced: number[] = [];
  child.kill = () => {
    child.killCalls += 1;
    child.exitCode = 0;
    alive = false;
    return true;
  };

  await stopOwnedChromiumProcesses(
    child as never,
    null,
    {
      isProcessAlive() {
        return alive;
      },
      async waitForPidExit() {},
      async forceTerminateProcessTree(pid) {
        forced.push(pid);
      },
    },
  );

  assert.equal(child.killCalls, 1);
  assert.deepEqual(forced, []);
  assert.equal(child.unrefCalls, 0);
});
