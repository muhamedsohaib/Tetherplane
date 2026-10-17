import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { hasActionPhaseOverlap, operatorAcceptanceAllowed, operatorAcceptanceHostAllowed } from "./helpers/operator-acceptance-gate.ts";
import { startLocalCompact, type LocalCompactHarness } from "./helpers/start-local.ts";

type Metrics = { sample_count: number; cursor_motion_samples: number; input_change_samples: number; first_sample_ms: number; last_sample_ms: number };
type Snapshot = {
  ready: boolean;
  active_phase: string;
  sample_count: number;
  cursor_motion_samples: number;
  input_change_samples: number;
  clipboard_change_samples: number;
  owned_foreground_samples: number;
  phase_samples: Record<string, Metrics>;
  finished: boolean;
};
type Fixture = {
  ready: boolean;
  focused: boolean;
  selected: string | null;
  selected_index: number;
  selection_events: number;
  text: string;
  status: string;
  pid: number;
};
type Node = {
  reference: string;
  name: string;
  patterns: string[];
  origin: string;
  process_id: number;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const optedIn = process.platform === "win32" &&
  process.env.GITHUB_ACTIONS !== "true" &&
  process.env.TETHERPLANE_OPERATOR_ACTIVE_ACCEPTANCE === "1" &&
  process.env.TETHERPLANE_INTERACTIVE_DESKTOP_ACCEPTANCE === "1";
const actualSha = optedIn
  ? execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot, encoding: "utf8", windowsHide: true, timeout: 10_000,
    }).trim()
  : "";
const allowed = optedIn && operatorAcceptanceHostAllowed(os.hostname()) && operatorAcceptanceAllowed({
  interactive: process.env.TETHERPLANE_INTERACTIVE_DESKTOP_ACCEPTANCE,
  operatorActive: process.env.TETHERPLANE_OPERATOR_ACTIVE_ACCEPTANCE,
  deadline: process.env.TETHERPLANE_OPERATOR_APPROVAL_DEADLINE,
  approvedSha: process.env.TETHERPLANE_APPROVED_CANDIDATE_SHA,
}, actualSha, Date.now());

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}
function structured(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
  const part = (result.content as Array<{ type?: unknown; text?: unknown }>)
    .find((item) => item.type === "text" && typeof item.text === "string");
  assert.ok(part && typeof part.text === "string", "missing MCP result");
  return JSON.parse(part.text) as Record<string, unknown>;
}

async function waitForJson<T>(
  file: string,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(file, "utf8")) as T;
      if (predicate(last)) return last;
    } catch {
      // The test-owned writer may be updating its bounded JSON snapshot.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("test-owned state did not converge: " + JSON.stringify(last));
}

async function waitForOwnedProcessExit(client: Client, handle: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await call(client, "process", {
      op: "read", args: { handle, timeout_ms: 100 },
    });
    assert.equal(result.isError, undefined, "fixture process handle unavailable");
    const state = structured(result);
    if (state.running === false) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("test-owned WinForms fixture did not exit after its stop signal or lifetime");
}

async function waitForSamplerExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("read-only sampler did not exit")), timeoutMs);
    child.once("exit", (code) => { clearTimeout(timeout); resolve(code); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

test("operator-active candidate UIA actions occur concurrently with genuine human input", {
  skip: !allowed,
  timeout: 90_000,
}, async (t) => {
  const approvalDeadline = Date.parse(process.env.TETHERPLANE_OPERATOR_APPROVAL_DEADLINE!);
  function ensureApprovedTime() {
    assert.ok(Date.now() + 20_000 < approvalDeadline,
      "operator approval expiring; stop before another candidate action");
  }
  ensureApprovedTime();

  const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-active-coexistence-"));
  const marker = path.join(temp, "activity-phase.txt");
  const snapshotPath = path.join(temp, "activity.json");
  const samplerStop = path.join(temp, "stop-sampler");
  const fixtureStop = path.join(temp, "stop-fixture");
  const fixtureState = path.join(temp, "fixture.json");

  let local: LocalCompactHarness | undefined;
  let fixtureHandle: string | undefined;
  let sampler: ChildProcess | undefined;
  let samplerStderr = "";
  let probeFinished = false;
  let fixtureExited = false;

  try {
    local = await startLocalCompact();
    const tools = (await local.client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, ["batch", "browser", "desktop", "device", "files", "process"]);

    const started = await call(local.client, "process", {
      op: "run", args: {
        program: "powershell.exe",
        args: [
          "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass",
          "-File", path.join(here, "fixtures", "windows-desktop-fixture.ps1"),
          "-StatePath", fixtureState, "-Title", "Tetherplane Operator Concurrent Fixture",
          "-Prefix", "Concurrent", "-BackgroundOnly", "-LifetimeMs", "30000",
          "-StopPath", fixtureStop,
        ],
        wait_ms: 0, pty: false,
      },
    });
    assert.equal(started.isError, undefined);
    const proc = structured(started);
    assert.equal(typeof proc.handle, "string");
    assert.equal(typeof proc.pid, "number");
    fixtureHandle = proc.handle as string;
    const ownedPid = proc.pid as number;
    const before = await waitForJson<Fixture>(fixtureState,
      (s) => s.ready && s.selected === "Concurrent Alpha" && s.pid === ownedPid);
    assert.equal(before.focused, false);
    assert.equal(before.selected_index, 0);

    await writeFile(marker, "baseline", "utf8");
    sampler = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(here, "fixtures", "windows-operator-activity-probe.ps1"),
      "-MarkerPath", marker, "-SnapshotPath", snapshotPath, "-StopPath", samplerStop,
      "-LifetimeMs", "30000", "-SampleIntervalMs", "2", "-OwnedPid", String(ownedPid),
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    sampler.stderr?.on("data", (chunk) => {
      samplerStderr = (samplerStderr + String(chunk)).slice(0, 500);
    });

    // Do not claim an operator-active run if the operator is idle.
    await waitForJson<Snapshot>(snapshotPath, (s) =>
      s.ready && s.active_phase === "baseline" &&
      (s.phase_samples.baseline?.cursor_motion_samples ?? 0) >= 3 &&
      (s.phase_samples.baseline?.input_change_samples ?? 0) >= 3, 12_000);

    const desktop = await call(local.client, "desktop",
      { op: "snapshot", args: { max_nodes: 1000 } });
    assert.equal(desktop.isError, undefined);
    const nodes = (structured(desktop).nodes as Node[]).filter((node) =>
      node.process_id === ownedPid && node.origin === "tetherplane");
    assert.ok(nodes.length > 0, "candidate must observe test-owned WinForms fixture");

    const value = nodes.find((node) => node.patterns.includes("value"));
    const invoke = nodes.find((node) => node.patterns.includes("invoke"));
    const beta = nodes.find((node) =>
      node.patterns.includes("selection") && node.name.includes("Beta"));
    assert.ok(value && invoke && beta, "missing owned semantic UIA action targets");

    const actionIntervals: Record<string, { started_at_ms: number; finished_at_ms: number }> = {};

    async function runAction(
      phase: "set_value" | "invoke" | "select",
      target: Node,
      proposedValue?: string,
    ) {
      ensureApprovedTime();
      const beforeMarker = await waitForJson<Snapshot>(snapshotPath, (s) => s.ready);
      // Acknowledge readiness without counting pre-dispatch movement.
      await writeFile(marker, "prepare:" + phase, "utf8");
      await waitForJson<Snapshot>(snapshotPath, (s) =>
        s.active_phase === "prepare:" + phase && s.sample_count > beforeMarker.sample_count);
      await writeFile(marker, phase, "utf8");
      const startedAt = Date.now();
      const result = await call(local!.client, "desktop", {
        op: "act", args: { reference: target.reference, action: phase, ...(proposedValue ?
          { value: proposedValue } : {}) },
      });
      actionIntervals[phase] = { started_at_ms: startedAt, finished_at_ms: Date.now() };
      // Close the action window before idle follow-up observation. Operator
      // movement only after the RPC must not count as concurrent input.
      await writeFile(marker, "baseline", "utf8");
      assert.equal(result.isError, undefined, phase + " rejected");
      const response = structured(result);
      if (phase !== "invoke") {
        // Native invoke reports executed_unverified by design. Verify the
        // application-observed effect, never mislabel its transport as verified.
        assert.equal(response.verified, true, phase + " not verified");
      } else {
        assert.equal(response.verified, false, "invoke provider verification contract changed");
      }
      const state = await waitForJson<Fixture>(fixtureState, (s) => {
        if (!s.ready) return false;
        if (phase === "set_value") return s.text === proposedValue;
        if (phase === "invoke") return s.status === "invoked";
        return s.selected === "Concurrent Beta" && s.selected_index === 1 &&
          s.selection_events === before.selection_events + 1;
      });
      assert.equal(state.focused, false, "test-owned fixture stole foreground focus");
    }

    await runAction("set_value", value, "concurrent-semantic-value");
    await runAction("invoke", invoke);
    await runAction("select", beta);
    await writeFile(marker, "post", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 250));

    const finalState = await waitForJson<Fixture>(fixtureState, (s) =>
      s.text === "concurrent-semantic-value" && s.status === "invoked" &&
      s.selected === "Concurrent Beta" && s.selected_index === 1 &&
      s.selection_events > before.selection_events);
    assert.equal(finalState.selection_events, before.selection_events + 1);
    assert.equal(finalState.focused, false);

    // All active motion evidence must overlap the actual semantic action phases.
    const observations = await waitForJson<Snapshot>(snapshotPath,
      (s) => s.active_phase === "post");
    const phases = ["set_value", "invoke", "select"];
    const motion = phases.reduce((sum, phase) =>
      sum + (observations.phase_samples[phase]?.cursor_motion_samples ?? 0), 0);
    const activity = phases.reduce((sum, phase) =>
      sum + (observations.phase_samples[phase]?.input_change_samples ?? 0), 0);
    // Very short RPCs may finish between consecutive read-only sampler ticks.
    // The acceptance contract requires evidence inside at least one action,
    // not an observation from every independent semantic RPC.
    const sampleSummary = Object.fromEntries(phases.map((phase) => {
      const bucket = observations.phase_samples[phase];
      const interval = actionIntervals[phase];
      return [phase, {
        samples: bucket?.sample_count ?? 0,
        cursorMotion: bucket?.cursor_motion_samples ?? 0,
        inputChanges: bucket?.input_change_samples ?? 0,
        rpcDurationMs: interval ? interval.finished_at_ms - interval.started_at_ms : null,
        firstSampleOffsetMs: typeof bucket?.first_sample_ms === "number" && interval
          ? bucket.first_sample_ms - interval.started_at_ms : null,
        lastSampleOffsetMs: typeof bucket?.last_sample_ms === "number" && interval
          ? bucket.last_sample_ms - interval.started_at_ms : null,
      }];
    }));
    t.diagnostic("ACTION_OVERLAP_COUNTS " + JSON.stringify(sampleSummary));
    assert.ok(hasActionPhaseOverlap(observations.phase_samples, actionIntervals),
      "no sustained operator cursor movement and input changes inside one semantic RPC; result is inconclusive");
    assert.equal(observations.clipboard_change_samples, 0, "system clipboard changed");
    assert.equal(observations.owned_foreground_samples, 0, "candidate fixture took foreground");
    t.diagnostic("CONCURRENT_COEXISTENCE " + JSON.stringify({
      candidateSha: actualSha,
      operatorInputChangesDuringActions: activity,
      operatorCursorSamplesDuringActions: motion,
      ownedForegroundSamples: observations.owned_foreground_samples,
      clipboardChanges: observations.clipboard_change_samples,
      selected: finalState.selected,
      managedSelectionEvents: finalState.selection_events - before.selection_events,
    }));
  } catch (error) {
    // Surface read-only probe failures before fixture cleanup masks the cause.
    // Never expose raw input, cursor coordinates or clipboard contents.
    const message = error instanceof Error ? error.message : String(error);
    const exitStatus = sampler?.exitCode ?? (sampler ? "still_running" : "not_started");
    throw new Error(
      message + "; activity_probe_exit=" + exitStatus +
      "; activity_probe_stderr=" + (samplerStderr.trim().slice(-500) || "(empty)"),
      { cause: error },
    );
  } finally {
    // Signal only the two processes created by this test. Both also have TTLs.
    await Promise.all([
      writeFile(fixtureStop, "stop", "utf8").catch(() => undefined),
      writeFile(samplerStop, "stop", "utf8").catch(() => undefined),
    ]);
    if (sampler) {
      try {
        const exit = await waitForSamplerExit(sampler, 5_000);
        probeFinished = exit === 0;
      } catch {
        // Only the sampler spawned by this test may be force-stopped.
        if (sampler.exitCode === null && sampler.signalCode === null) sampler.kill();
        await waitForSamplerExit(sampler, 2_000).catch(() => undefined);
      }
    }
    if (local && fixtureHandle) {
      await waitForOwnedProcessExit(local.client, fixtureHandle, 33_000)
        .then(() => { fixtureExited = true; })
        .catch(() => { fixtureExited = false; });
    }
    if (local) await local.close().catch(() => undefined);
    // Preserve the stop signal until the WinForms lifetime has ended.
    if (fixtureExited && probeFinished) {
      await rm(temp, { recursive: true, force: true });
    }
  }
  assert.equal(probeFinished, true, "read-only sampler did not exit cleanly: " +
    samplerStderr.slice(0, 200));
  assert.equal(fixtureExited, true, "test-owned fixture failed to exit; stop files retained");
});
