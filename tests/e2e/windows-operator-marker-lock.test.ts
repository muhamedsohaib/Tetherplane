import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
}

async function waitForFile(file: string): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    try { return await readFile(file, "utf8"); } catch { /* not yet written */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("test-owned marker lock never acquired");
}

test("read-only sampler survives a transient exclusive lock on its phase marker", {
  skip: process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true",
  timeout: 18_000,
}, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "tetherplane-marker-sharing-"));
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)),
    "fixtures", "windows-operator-activity-probe.ps1");
  const marker = path.join(folder, "phase.txt");
  const snapshot = path.join(folder, "activity.json");
  const stop = path.join(folder, "stop");
  const locked = path.join(folder, "marker-locked");
  await writeFile(marker, "baseline");
  const sampler = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-MarkerPath", marker, "-SnapshotPath", snapshot, "-StopPath", stop,
    "-LifetimeMs", "10000", "-SampleIntervalMs", "2",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  sampler.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-900); });
  const exited = waitForExit(sampler);
  let lockProcess: ChildProcess | undefined;
  try {
    for (let i = 0; i < 120; i += 1) {
      try {
        const state = JSON.parse(await readFile(snapshot, "utf8"));
        if (state.ready && !state.finished) break;
      } catch { /* transient JSON write */ }
      if (sampler.exitCode !== null) throw new Error("sampler exited before readiness: " + stderr);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const quotedMarker = marker.replaceAll("'", "''");
    const quotedLocked = locked.replaceAll("'", "''");
    const lockScript = [
      "$ErrorActionPreference='Stop'",
      `$s=[System.IO.File]::Open('${quotedMarker}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None)`,
      `try { [System.IO.File]::WriteAllText('${quotedLocked}','locked'); Start-Sleep -Milliseconds 950 } finally { $s.Dispose() }`,
    ].join("; ");
    lockProcess = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", lockScript],
      { windowsHide: true, stdio: "ignore" });
    const lockExit = waitForExit(lockProcess);
    assert.equal((await waitForFile(locked)).trim(), "locked");
    assert.equal(await lockExit, 0, "test-owned exclusive lock process failed");
    // The sampler must not terminate during a writer's brief exclusive lock.
    assert.equal(sampler.exitCode, null, "sampler crashed on phase-marker sharing violation: " + stderr);
    await writeFile(marker, "prepare:select");
    for (let i = 0; i < 100; i += 1) {
      try {
        const state = JSON.parse(await readFile(snapshot, "utf8"));
        if (state.active_phase === "prepare:select" && !state.finished) break;
      } catch { /* transient JSON write */ }
      if (sampler.exitCode !== null) throw new Error("sampler exited after marker lock: " + stderr);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(sampler.exitCode, null, "sampler did not survive marker update: " + stderr);
    await writeFile(stop, "stop");
    assert.equal(await exited, 0, "sampler failed clean exit: " + stderr);
  } finally {
    await writeFile(stop, "stop").catch(() => undefined);
    if (lockProcess && lockProcess.exitCode === null) lockProcess.kill();
    if (sampler.exitCode === null && sampler.signalCode === null) sampler.kill();
    await exited.catch(() => undefined);
    await rm(folder, { recursive: true, force: true });
  }
});
