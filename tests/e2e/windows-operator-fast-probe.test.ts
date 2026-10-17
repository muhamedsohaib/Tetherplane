import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("read-only fast sampler captures multiple observations in a 200ms action phase", {
  skip: process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true",
  timeout: 14_000,
}, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tetherplane-fast-probe-"));
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)),
    "fixtures", "windows-operator-activity-probe.ps1");
  const marker = path.join(home, "phase.txt");
  const snapshot = path.join(home, "snapshot.json");
  const stop = path.join(home, "stop");
  await writeFile(marker, "baseline");
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-MarkerPath", marker, "-SnapshotPath", snapshot, "-StopPath", stop,
    "-LifetimeMs", "7000", "-SampleIntervalMs", "2",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-700);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  async function observe(phase: string, minimum: number) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child.exitCode !== null) throw new Error("probe exited early: " + stderr);
      try {
        const snap = JSON.parse(await readFile(snapshot, "utf8")) as {
          active_phase: string;
          phase_samples: Record<string, { sample_count: number }>;
        };
        if (snap.active_phase === phase &&
            (snap.phase_samples[phase]?.sample_count ?? 0) >= minimum) return snap;
      } catch {
        // A pending write may not yet have completed.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("probe did not publish " + phase + ": " + stderr);
  }
  try {
    await observe("baseline", 1);
    await writeFile(marker, "prepare:select");
    // Readiness handshake must not count as action motion.
    for (let attempts = 0; attempts < 100; attempts += 1) {
      const snap = JSON.parse(await readFile(snapshot, "utf8"));
      if (snap.active_phase === "prepare:select") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await writeFile(marker, "select");
    await observe("select", 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const final = await observe("select", 5);
    assert.ok((final.phase_samples.select?.sample_count ?? 0) >= 5,
      "the sampler must record five or more read-only ticks in a 200ms phase");
    await writeFile(stop, "stop");
    const exit = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("fast probe ignored stop signal")), 3_000)),
    ]);
    assert.equal(exit, 0, stderr);
  } finally {
    await writeFile(stop, "stop").catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});
