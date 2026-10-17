import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import {
  classifyBackgroundDesktopObservation,
  readWindowsLastInputTick,
} from "./helpers/background-desktop-observation.ts";

const baseline = {
  cursorBefore: { x: 574, y: 706 },
  cursorAfter: { x: 574, y: 706 },
  foregroundBefore: 10,
  foregroundAfter: 10,
  clipboardBefore: "stable",
  clipboardAfter: "stable",
  inputTickBefore: 1000,
  inputTickAfter: 1000,
};

test("unchanged physical desktop is verified", () => {
  assert.equal(classifyBackgroundDesktopObservation(baseline), "verified");
});

test("cursor drift without input activity is a coexistence violation", () => {
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, cursorAfter: { x: 412, y: 0 },
  }), "violation");
});

test("cursor drift with intervening physical input is inconclusive, never verified", () => {
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, cursorAfter: { x: 412, y: 0 }, inputTickAfter: 1200,
  }), "inconclusive");
});

test("foreground switch without input is a violation, with input is inconclusive", () => {
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, foregroundAfter: 20,
  }), "violation");
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, foregroundAfter: 20, inputTickAfter: 1200,
  }), "inconclusive");
});

test("clipboard mutations are not silently accepted as coexistence verification", () => {
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, clipboardAfter: "changed",
  }), "violation");
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, clipboardAfter: "changed", inputTickAfter: 1200,
  }), "inconclusive");
});

test("last-input probe avoids PowerShell C# compilation and reads through bounded Python ctypes", (t) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {
    ...originalPlatform,
    value: "win32",
  });
  const calls: Array<{
    file: string;
    args: string[];
    options: childProcess.ExecFileSyncOptions;
  }> = [];
  t.mock.method(childProcess, "execFileSync", (
    file: string,
    args: string[],
    options: childProcess.ExecFileSyncOptions,
  ) => {
    calls.push({ file, args, options });
    return "123456\n";
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", originalPlatform);
  });

  assert.equal(readWindowsLastInputTick(), 123456);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.match(call.file, /^python(?:\.exe)?$/i);
  assert.deepEqual(call.args.slice(0, 1), ["-c"]);
  assert.match(call.args[1]!, /ctypes/);
  assert.match(call.args[1]!, /GetLastInputInfo/);
  assert.doesNotMatch(call.args[1]!, /SetCursorPos|SendInput|Clipboard|SetForegroundWindow/);
  assert.equal(call.options.windowsHide, true);
  assert.ok((call.options.timeout ?? 0) > 0);
  assert.ok((call.options.timeout ?? Infinity) <= 15_000);
});

test("last-input probe supplies a bounded non-secret OS tick on Windows", {
  skip: process.platform !== "win32",
}, () => {
  const tick = readWindowsLastInputTick();
  assert.ok(Number.isSafeInteger(tick));
  assert.ok(tick >= 0 && tick <= 0xffffffff);
});
