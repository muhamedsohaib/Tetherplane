import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

import { getForegroundInfo } from "./helpers/windows-foreground.ts";

const output = "123:456:fixture:FixtureWindow\r\n";
const expected = {
  hwnd: 123, pid: 456, processName: "fixture", className: "FixtureWindow",
  raw: output.trim(),
};

function mockProbe(t: test.TestContext, compiled: () => string, fallback = () => output) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const calls: Array<{ file: string; args: string[]; options: childProcess.ExecFileSyncOptions }> = [];
  t.mock.method(fs, "existsSync", () => true);
  t.mock.method(childProcess, "execFileSync", (file: string, argsOrOptions: string[] | childProcess.ExecFileSyncOptions, options?: childProcess.ExecFileSyncOptions) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const actualOptions = Array.isArray(argsOrOptions) ? options! : argsOrOptions;
    calls.push({ file, args, options: actualOptions });
    return file === "powershell.exe" ? fallback() : compiled();
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  });
  return calls;
}

test("foreground helper falls back only when the compiled probe cannot launch", (t) => {
  let failure: Error;
  const calls = mockProbe(t, () => { throw failure; });
  for (const code of ["EACCES", "EPERM", "ENOENT", "ENOEXEC", "UNKNOWN"]) {
    failure = Object.assign(new Error("probe launch denied"), {
      code, syscall: "spawnSync fixture.exe", pid: 0, status: null, signal: null,
    });
    calls.length = 0;
    assert.deepEqual(getForegroundInfo(), expected);
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.file, /tetherplane-fg-probe\.exe$/);
    assert.equal(calls[1]!.file, "powershell.exe");
    for (const call of calls) assert.equal(call.options.windowsHide, true);
    assert.deepEqual(calls[1]!.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-Sta", "-Command"]);
    const script = calls[1]!.args[4]!;
    assert.match(script, /OpenInputDesktop/);
    assert.match(script, /GetForegroundWindow/);
    assert.doesNotMatch(script, /SetForegroundWindow|SetCursorPos|SendInput|Clipboard|ShowWindow/);
  }
});

test("foreground helper prefers a successful compiled probe", (t) => {
  const calls = mockProbe(t, () => output);
  assert.deepEqual(getForegroundInfo(), expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.windowsHide, true);
});

test("foreground helper preserves execution timeouts nonzero exits and unrelated errors", (t) => {
  let failure: Error;
  const calls = mockProbe(t, () => { throw failure; });
  for (const details of [
    { code: "ETIMEDOUT", syscall: "spawnSync fixture.exe", pid: 42, status: null, signal: "SIGTERM" },
    { status: 1, pid: 42, signal: null },
    { code: "UNKNOWN", syscall: "spawnSync fixture.exe", pid: 42, status: 1, signal: null },
    { code: "EPERM", syscall: "read", pid: 0, status: null, signal: null },
    {},
  ]) {
    failure = Object.assign(new Error("probe failed after launch"), details);
    calls.length = 0;
    assert.throws(() => getForegroundInfo(), error => error === failure);
    assert.equal(calls.length, 1);
  }
});

test("foreground helper rejects malformed compiled output without falling back", (t) => {
  let invalid = "";
  const calls = mockProbe(t, () => invalid);
  for (invalid of ["", "not a foreground observation", "NaN:456:fixture:Window", "123:456:fixture:Window\nextra", "9007199254740992:456:fixture:Window"]) {
    calls.length = 0;
    assert.throws(() => getForegroundInfo(), /Invalid foreground probe output/);
    assert.equal(calls.length, 1);
  }
});

test("foreground helper exposes PowerShell failures after a blocked compiled probe", (t) => {
  const blocked = Object.assign(new Error("blocked"), {
    code: "UNKNOWN", syscall: "spawnSync fixture.exe", pid: 0, status: null, signal: null,
  });
  const failure = new Error("PowerShell probe failed");
  const calls = mockProbe(t, () => { throw blocked; }, () => { throw failure; });
  assert.throws(() => getForegroundInfo(), error => error === failure);
  assert.equal(calls.length, 2);
});

test("foreground helper also rejects malformed PowerShell output", (t) => {
  const blocked = Object.assign(new Error("blocked"), {
    code: "EACCES", syscall: "spawnSync fixture.exe", pid: 0, status: null, signal: null,
  });
  const calls = mockProbe(t, () => { throw blocked; }, () => "");
  assert.throws(() => getForegroundInfo(), /Invalid foreground probe output/);
  assert.equal(calls.length, 2);
});
