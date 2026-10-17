import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)),
  "fixtures", "windows-desktop-fixture.ps1");

test("fixture lifetime starts after Shown and timer is disposed on close", async () => {
  // Pure source contract: does not create or manipulate a window on Leno.
  const script = await readFile(fixturePath, "utf8");
  const shown = script.indexOf("$form.Add_Shown({");
  const closed = script.indexOf("$form.Add_FormClosed({");
  const timerStart = script.indexOf("$timer.Start()");
  const lifetimeRestart = script.indexOf("$lifetime.Restart()");
  const timerStop = script.indexOf("$timer.Stop()");
  const timerDispose = script.indexOf("$timer.Dispose()");
  assert.ok(shown >= 0, "fixture requires a Shown event");
  assert.ok(closed > shown, "fixture must dispose its timer on FormClosed");
  assert.ok(timerStart > shown && timerStart < closed,
    "WinForms timer must start after Shown, never before the UI message pump");
  assert.ok(lifetimeRestart > shown && lifetimeRestart < timerStart,
    "the lifetime budget must begin when the form becomes visible to the message loop");
  assert.ok(timerStop > closed && timerDispose > timerStop,
    "FormClosed must stop and dispose the test-owned timer");
});

type FixturePhase = "readiness" | "shutdown";
type FixtureState = { ready?: boolean | undefined; focused?: boolean | undefined; pid?: number | undefined };
type FixtureDiagnostics = {
  pid: number | undefined;
  exitCode: number | null;
  signalCode: string | null;
  lastState: FixtureState | null;
  stderr: string;
};

function describeFixtureFailure(phase: FixturePhase, details: FixtureDiagnostics): string {
  const state = details.lastState;
  return [
    `phase=${phase}`,
    `pid=${details.pid ?? "missing"}`,
    `exitCode=${details.exitCode}`,
    `signalCode=${details.signalCode}`,
    `ready=${state?.ready ?? "unknown"}`,
    `focused=${state?.focused ?? "unknown"}`,
    `statePid=${state?.pid ?? "unknown"}`,
    `stderr=${details.stderr.trim().slice(-2048) || "(empty)"}`,
  ].join(" ");
}

test("fixture timeout diagnostics distinguish readiness from shutdown", () => {
  const observation: FixtureDiagnostics = {
    pid: 1234,
    exitCode: null,
    signalCode: null,
    lastState: { ready: true, focused: false, pid: 1234 },
    stderr: "fixture diagnostic",
  };
  const startup = describeFixtureFailure("readiness", observation);
  const shutdown = describeFixtureFailure("shutdown", observation);
  for (const report of [startup, shutdown]) {
    assert.match(report, /pid=1234/);
    assert.match(report, /exitCode=null/);
    assert.match(report, /ready=true/);
    assert.match(report, /fixture diagnostic/);
  }
  assert.match(startup, /readiness/);
  assert.match(shutdown, /shutdown/);
});

test("background desktop fixture expires without a stop signal", {
  skip: process.platform !== "win32",
  timeout: 40_000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-fixture-lifetime-"));
  const statePath = path.join(temp, "state.json");
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass",
    "-File", fixturePath, "-StatePath", statePath,
    "-Title", "Tetherplane Lifetime Fixture", "-Prefix", "Lifetime",
    "-BackgroundOnly", "-LifetimeMs", "500",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });

  let stderr = "";
  let spawnError: Error | undefined;
  let lastState: FixtureState | null = null;
  let phase: FixturePhase = "readiness";
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve({ code: null, signal: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stderr?.on("data", (chunk) => {
    // Only retain bounded output from this test-owned PowerShell fixture.
    stderr = (stderr + String(chunk)).slice(-2048);
  });

  try {
    const startupDeadline = Date.now() + 20_000;
    while (Date.now() < startupDeadline) {
      try {
        const state = JSON.parse(await readFile(statePath, "utf8")) as FixtureState;
        const observed: FixtureState = {
          ready: state.ready,
          focused: state.focused,
          pid: state.pid,
        };
        lastState = observed;
        if (observed.ready === true) break;
      } catch {
        // File may not exist yet or the fixture may be replacing its JSON.
      }
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error("fixture exited or failed before writing ready=true");
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    if (lastState?.ready !== true) {
      throw new Error("fixture readiness not observed within 20000ms");
    }
    assert.equal(lastState.focused, false, "fixture must not activate a human desktop");
    assert.equal(lastState.pid, child.pid, "ready snapshot must belong to test-owned PID");

    phase = "shutdown";
    const exitedNormally = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        shutdownTimer = setTimeout(() =>
          reject(new Error("fixture did not exit within 8000ms after readiness")), 8_000);
      }),
    ]);
    clearTimeout(shutdownTimer);
    assert.equal(exitedNormally.code, 0, "fixture must exit with code 0");
    assert.equal(stderr.trim(), "", "fixture must not hide unsupported runtime APIs");
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
      describeFixtureFailure(phase, {
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        lastState,
        stderr: stderr + (spawnError ? ` ${spawnError.message}` : ""),
      }),
      { cause: error },
    );
  } finally {
    clearTimeout(shutdownTimer);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupCompleted = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        cleanupTimer = setTimeout(() => resolve(false), 3_000);
      }),
    ]);
    clearTimeout(cleanupTimer);
    await rm(temp, { recursive: true, force: true });
    if (!cleanupCompleted) {
      throw new Error(`test-owned fixture PID ${child.pid} did not terminate during cleanup`);
    }
  }
});
