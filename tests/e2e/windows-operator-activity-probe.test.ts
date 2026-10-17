import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type PhaseMetrics = {
  sample_count: number;
  cursor_motion_samples: number;
  input_change_samples: number;
  first_sample_ms: number;
  last_sample_ms: number;
};
type ProbeSnapshot = {
  ready: boolean;
  active_phase: string;
  sample_count: number;
  cursor_motion_samples: number;
  input_change_samples: number;
  clipboard_change_samples: number;
  owned_foreground_samples: number;
  phase_samples: Record<string, PhaseMetrics>;
  elapsed_ms: number;
  finished: boolean;
};

async function waitForSnapshot(
  file: string,
  predicate: (snapshot: ProbeSnapshot) => boolean,
): Promise<ProbeSnapshot> {
  let last: ProbeSnapshot | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      last = JSON.parse(await readFile(file, "utf8")) as ProbeSnapshot;
      if (predicate(last)) return last;
    } catch {
      // Snapshot file may be temporarily replaced by the bounded sampler.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("operator sampler did not acknowledge requested phase: " + JSON.stringify(last));
}

test("Windows sampler records only bounded read-only phase aggregates and closes on stop", {
  skip: process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true",
  timeout: 18_000,
}, async () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)),
    "fixtures", "windows-operator-activity-probe.ps1");
  assert.equal(existsSync(script), true, "Windows input sampler implementation is missing");
  const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-operator-sampler-"));
  const marker = path.join(temp, "phase.txt");
  const snapshot = path.join(temp, "snapshot.json");
  const stop = path.join(temp, "stop");
  await writeFile(marker, "baseline", "utf8");
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-MarkerPath", marker, "-SnapshotPath", snapshot, "-StopPath", stop,
    "-LifetimeMs", "8000", "-SampleIntervalMs", "50",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(0, 500); });
  let exitTimeout: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });

  try {
    const baseline = await waitForSnapshot(snapshot,
      (s) => s.ready && s.active_phase === "baseline" && s.sample_count > 0);
    assert.equal(baseline.finished, false);
    await writeFile(marker, "prepare:select", "utf8");
    const prepared = await waitForSnapshot(snapshot, (s) => s.active_phase === "prepare:select");
    assert.equal(prepared.phase_samples.select?.sample_count, 0,
      "readiness acknowledgment must not enter the measured action phase");
    await writeFile(marker, "select", "utf8");
    const selected = await waitForSnapshot(snapshot,
      (s) => s.active_phase === "select" && (s.phase_samples.select?.sample_count ?? 0) > 0);
    assert.ok(selected.sample_count >= baseline.sample_count);
    assert.ok(Number.isSafeInteger(selected.phase_samples.select?.first_sample_ms));
    assert.ok(Number.isSafeInteger(selected.phase_samples.select?.last_sample_ms));
    await writeFile(stop, "stop", "utf8");
    const exitCode = await Promise.race([exited, new Promise<never>((_, reject) => {
      exitTimeout = setTimeout(() => reject(new Error("Windows sampler ignored stop signal")), 5_000);
    })]);
    clearTimeout(exitTimeout);
    assert.equal(exitCode, 0, stderr);
    const final = await waitForSnapshot(snapshot, (s) => s.finished === true);
    assert.ok(final.sample_count >= selected.sample_count);
    assert.ok(final.elapsed_ms <= 8_000);
    assert.ok(Number.isInteger(final.cursor_motion_samples));
    assert.ok(Number.isInteger(final.input_change_samples));
    assert.ok(Number.isInteger(final.clipboard_change_samples));
    assert.ok(Number.isInteger(final.owned_foreground_samples));
    for (const metrics of Object.values(final.phase_samples)) {
      assert.ok(Number.isInteger(metrics.sample_count));
      assert.ok(Number.isInteger(metrics.cursor_motion_samples));
      assert.ok(Number.isInteger(metrics.input_change_samples));
    }
    const fields = JSON.stringify(final);
    for (const forbidden of ["cursor_x", "cursor_y", "foreground_handle", "window_title",
      "clipboard_text", "typed_text", "input_tick"]) {
      assert.equal(fields.includes(forbidden), false, "sampler exposed " + forbidden);
    }
  } finally {
    clearTimeout(exitTimeout);
    await writeFile(stop, "stop", "utf8").catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
});
