import assert from "node:assert/strict";
import test from "node:test";

import { getForegroundInfo } from "./helpers/windows-foreground.ts";

test(
  "foreground probe is stable and does not cause a foreground transition",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    const initial = getForegroundInfo();
    assert.ok(initial.hwnd > 0, "expected valid non-zero foreground HWND");
    assert.ok(initial.pid > 0, "expected valid non-zero process ID");
    assert.ok(initial.processName.length > 0, "expected non-empty process name");

    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const current = getForegroundInfo();
      assert.equal(
        current.hwnd,
        initial.hwnd,
        `foreground HWND changed at iteration ${i}: expected ${initial.hwnd} (${initial.processName}), got ${current.hwnd} (${current.processName})`,
      );
      assert.equal(
        current.pid,
        initial.pid,
        `foreground PID changed at iteration ${i}: expected ${initial.pid} (${initial.processName}), got ${current.pid} (${current.processName})`,
      );
    }
  },
);
