import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import {
  createBoundedOutputCollector,
  evaluateFocusCoexistence,
  extractToolPayload,
  formatTapSafeDiagnosticLine,
  hasFixtureHeartbeatAdvanced,
  isFixtureRenderedReady,
  selectHumanInvokeTarget,
  selectOwnedFixtureTargets,
  summarizeNodesForDiagnostics,
  type DesktopNode,
  type ExtractedToolPayload,
  type FixtureStateSnapshot,
  type FocusCoexistenceVerdict,
} from "./helpers/desktop-coexistence-helpers.ts";
import { startLocalCompact } from "./helpers/start-local.ts";
import {
  getCursorClipboardState,
  getForegroundInfo,
  type CursorClipboardState,
  type ForegroundInfo,
} from "./helpers/windows-foreground.ts";

type ForegroundRecord = {
  hwnd: number;
  pid: number;
  process_name: string;
  class_name: string;
};

type ForegroundCheckpoint = {
  label: string;
  at_iso: string;
  foreground: ForegroundRecord | null;
  foreground_error?: string;
};

type CursorCheckpoint = {
  label: string;
  at_iso: string;
  cursor: { x: number; y: number };
  dx_from_baseline: number | null;
  dy_from_baseline: number | null;
  clipboard_matches_baseline: boolean | null;
  foreground: ForegroundRecord | null;
  foreground_error?: string;
};

type ActionEvidenceRecord = {
  action: string;
  target: {
    reference: string;
    role: string | null;
    name: string;
    automation_id: string | null;
    class_name: string | null;
    patterns: string[];
  };
  at_iso: string;
  payload: ExtractedToolPayload;
  transport: string | null;
  verified: boolean | null;
};

const IDLE_CONTROL_INTERVAL_MS = 500;

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  return client.callTool({ name, arguments: args });
}

function structured(
  result: Awaited<ReturnType<typeof call>>,
): Record<string, unknown> {
  if (result.structuredContent) {
    return result.structuredContent as Record<string, unknown>;
  }

  const content = result.content as Array<{
    type?: unknown;
    text?: unknown;
  }>;
  const text = content.find(
    (item) => item.type === "text" && typeof item.text === "string",
  );
  assert.ok(
    text && typeof text.text === "string",
    "expected structuredContent or JSON text content",
  );
  return JSON.parse(text.text) as Record<string, unknown>;
}

function powershell(command: string): string {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Sta", "-Command", command],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 15_000,
    },
  ).trim();
}

function toForegroundRecord(info: ForegroundInfo | null): ForegroundRecord | null {
  if (!info) return null;
  return {
    hwnd: info.hwnd,
    pid: info.pid,
    process_name: info.processName,
    class_name: info.className,
  };
}

function readForegroundForDiagnostics(): {
  info: ForegroundInfo | null;
  error?: string;
} {
  try {
    return { info: getForegroundInfo() };
  } catch (error) {
    return { info: null, error: String(error) };
  }
}

function recordForegroundCheckpoint(
  timeline: ForegroundCheckpoint[],
  label: string,
): ForegroundInfo | null {
  const fg = readForegroundForDiagnostics();
  const checkpoint: ForegroundCheckpoint = {
    label,
    at_iso: new Date().toISOString(),
    foreground: toForegroundRecord(fg.info),
  };
  if (fg.error !== undefined) {
    checkpoint.foreground_error = fg.error;
  }
  timeline.push(checkpoint);
  return fg.info;
}

function recordCursorCheckpoint(
  timeline: CursorCheckpoint[],
  label: string,
  baseline: CursorClipboardState | null,
): { state: CursorClipboardState; foreground: ForegroundInfo | null } {
  const state = getCursorClipboardState();
  const fg = readForegroundForDiagnostics();
  const checkpoint: CursorCheckpoint = {
    label,
    at_iso: new Date().toISOString(),
    cursor: { x: state.cursor.x, y: state.cursor.y },
    dx_from_baseline: baseline ? state.cursor.x - baseline.cursor.x : null,
    dy_from_baseline: baseline ? state.cursor.y - baseline.cursor.y : null,
    clipboard_matches_baseline: baseline
      ? state.clipboardTextBase64 === baseline.clipboardTextBase64
      : null,
    foreground: toForegroundRecord(fg.info),
  };
  if (fg.error !== undefined) {
    checkpoint.foreground_error = fg.error;
  }
  timeline.push(checkpoint);
  return { state, foreground: fg.info };
}

function buildActionEvidence(
  action: string,
  node: DesktopNode,
  result: Awaited<ReturnType<typeof call>>,
): ActionEvidenceRecord {
  const payload = extractToolPayload(result);
  const transport =
    typeof payload.structured?.transport === "string"
      ? payload.structured.transport
      : null;
  const verified =
    typeof payload.structured?.verified === "boolean"
      ? payload.structured.verified
      : null;
  return {
    action,
    target: {
      reference: node.reference,
      role: node.role ?? null,
      name: node.name,
      automation_id: node.automation_id ?? null,
      class_name: node.class_name ?? null,
      patterns: [...node.patterns],
    },
    at_iso: new Date().toISOString(),
    payload,
    transport,
    verified,
  };
}

async function readState(statePath: string): Promise<FixtureStateSnapshot> {
  return JSON.parse(await readFile(statePath, "utf8")) as FixtureStateSnapshot;
}

async function waitForState(
  statePath: string,
  predicate: (state: FixtureStateSnapshot) => boolean,
  timeoutMs = 20_000,
): Promise<FixtureStateSnapshot> {
  // A fresh Windows Sandbox can start PowerShell/GUI fixtures slowly. Wait
  // for application state, not a fixed count of scheduler ticks.
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let lastState: FixtureStateSnapshot | undefined;
  let lastStage = "not-recorded";
  while (Date.now() < deadline) {
    try {
      const state = await readState(statePath);
      lastState = state;
      lastError = undefined;
      if (predicate(state)) return state;
    } catch (error) {
      lastError = error;
    }
    const startupErrorPath = statePath + ".startup.txt.error.txt";
    const startupError = await readFile(startupErrorPath, "utf8").catch(
      () => null,
    );
    if (startupError !== null) {
      throw new Error("fixture terminated during startup: " + startupError);
    }
    lastStage = await readFile(statePath + ".startup.txt", "utf8").catch(
      () => lastStage,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "fixture state did not reach expected condition within " + timeoutMs +
      "ms; last_stage=" + lastStage +
      "; last_state=" + JSON.stringify(lastState ?? null) +
      "; last_read_error=" + String(lastError ?? "none"),
  );
}

async function waitForCorroboratedFocusCoexistence(params: {
  framework: "WinForms" | "Wpf";
  ownedStatePath: string;
  humanStatePath: string;
  ownedReadyState: FixtureStateSnapshot;
  ownedPid: number;
  humanPid: number;
  timeoutMs?: number;
}): Promise<{
  ownedState: FixtureStateSnapshot;
  humanState: FixtureStateSnapshot;
  foreground: ForegroundInfo;
  verdict: FocusCoexistenceVerdict;
}> {
  const {
    framework,
    ownedStatePath,
    humanStatePath,
    ownedReadyState,
    ownedPid,
    humanPid,
    timeoutMs = 20_000,
  } = params;
  const deadline = Date.now() + timeoutMs;
  let lastOwned: FixtureStateSnapshot | null = null;
  let lastHuman: FixtureStateSnapshot | null = null;
  let lastForeground: ForegroundInfo | null = null;
  let lastForegroundError: string | undefined;
  let lastVerdict: FocusCoexistenceVerdict = {
    ready: false,
    reason: "pending",
    discrepancy: null,
  };
  let lastHeartbeatAdvanced = false;
  let lastReadError: unknown;
  let lastProbeAt = 0;

  while (Date.now() < deadline) {
    try {
      lastOwned = await readState(ownedStatePath);
      lastHuman = await readState(humanStatePath);
      lastReadError = undefined;
    } catch (error) {
      lastReadError = error;
    }

    for (const [label, statePath] of [
      ["owned", ownedStatePath],
      ["human", humanStatePath],
    ] as const) {
      const startupError = await readFile(
        statePath + ".startup.txt.error.txt",
        "utf8",
      ).catch(() => null);
      if (startupError !== null) {
        throw new Error(
          `${label} fixture terminated during focus coexistence check: ${startupError}`,
        );
      }
    }

    const now = Date.now();
    const candidatesReady =
      lastOwned?.focused === false &&
      lastHuman?.focused === true &&
      hasFixtureHeartbeatAdvanced(ownedReadyState, lastOwned);
    if (candidatesReady || now - lastProbeAt >= 500) {
      const fg = readForegroundForDiagnostics();
      lastForeground = fg.info;
      lastForegroundError = fg.error;
      lastProbeAt = now;
    }

    lastHeartbeatAdvanced = hasFixtureHeartbeatAdvanced(
      ownedReadyState,
      lastOwned,
    );
    lastVerdict = evaluateFocusCoexistence({
      framework,
      ownedState: lastOwned,
      humanState: lastHuman,
      ownedPid,
      humanPid,
      foreground: lastForeground,
    });
    if (lastVerdict.ready && lastHeartbeatAdvanced && lastForeground) {
      return {
        ownedState: lastOwned as FixtureStateSnapshot,
        humanState: lastHuman as FixtureStateSnapshot,
        foreground: lastForeground,
        verdict: lastVerdict,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const finalFg = readForegroundForDiagnostics();
  lastForeground = finalFg.info ?? lastForeground;
  lastForegroundError = finalFg.error ?? lastForegroundError;
  const ownedStage = await readFile(
    ownedStatePath + ".startup.txt",
    "utf8",
  ).catch(() => "not-recorded");
  const humanStage = await readFile(
    humanStatePath + ".startup.txt",
    "utf8",
  ).catch(() => "not-recorded");

  throw new Error(
    "fixture focus coexistence was not corroborated within " +
      timeoutMs +
      "ms; verdict=" +
      JSON.stringify(lastVerdict) +
      "; owned_heartbeat_advanced=" +
      String(lastHeartbeatAdvanced) +
      "; owned_ready_seq=" +
      String(ownedReadyState.state_seq ?? null) +
      "; owned_stage=" +
      ownedStage +
      "; human_stage=" +
      humanStage +
      "; owned_state=" +
      JSON.stringify(lastOwned) +
      "; human_state=" +
      JSON.stringify(lastHuman) +
      "; os_foreground=" +
      JSON.stringify(toForegroundRecord(lastForeground)) +
      "; os_foreground_error=" +
      String(lastForegroundError ?? "none") +
      "; last_read_error=" +
      String(lastReadError ?? "none"),
  );
}

async function waitForExactFile(
  filePath: string,
  expected: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let lastText: string | undefined;
  while (Date.now() < deadline) {
    try {
      lastText = await readFile(filePath, "utf8");
      lastError = undefined;
      if (lastText === expected) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    "Timed out waiting for exact file content: " + filePath +
      "; observed=" + JSON.stringify(lastText ?? null) +
      "; last_read_error=" + String(lastError ?? "none"),
  );
}

async function stopSpawnedFixture(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  const waitForExit = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, 5_000);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
  // Windows child.kill() requests process termination, but the event is
  // asynchronous. Never delete fixture state until its writer exits.
  child.kill();
  return await waitForExit;
}

async function runDesktopCoexistenceTest(framework: "WinForms" | "Wpf") {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.join(here, "fixtures", "windows-desktop-fixture.ps1");
  const temp = await mkdtemp(
    path.join(os.tmpdir(), `tetherplane-desktop-e2e-${framework.toLowerCase()}-`),
  );
  const ownedState = path.join(temp, "owned.json");
  const humanState = path.join(temp, "human.json");

  const local = await startLocalCompact();
  let ownedHandle: string | undefined;
  let ownedPid: number | undefined;
  let humanProcess: ChildProcess | undefined;
  let humanPid: number | undefined;
  const humanStdout = createBoundedOutputCollector(4096);
  const humanStderr = createBoundedOutputCollector(4096);
  let originalFailure: unknown;
  let currentStage = "init";
  let ownedNodesSummary: ReturnType<typeof summarizeNodesForDiagnostics> | null =
    null;
  let humanNodesSummary: ReturnType<typeof summarizeNodesForDiagnostics> | null =
    null;
  let selectedTargetsSummary: Record<string, unknown> | null = null;
  let idleControlSummary: Record<string, unknown> | null = null;
  let focusCoexistenceSummary: Record<string, unknown> | null = null;
  let baselineCursorState: CursorClipboardState | null = null;
  const foregroundTimeline: ForegroundCheckpoint[] = [];
  const cursorTimeline: CursorCheckpoint[] = [];
  const actionEvidence: Record<string, ActionEvidenceRecord> = {};

  try {
    currentStage = "list_tools";
    const listed = await local.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["batch", "browser", "desktop", "device", "files", "process"],
    );

    currentStage = "capabilities";
    const capabilities = structured(
      await call(local.client, "device", {
        op: "capabilities",
        args: {},
      }),
    );
    const providers = capabilities.providers as Array<Record<string, unknown>>;
    const desktop = providers.find((provider) => provider.namespace === "desktop");
    assert.equal(desktop?.available, true);

    // Pre-warm read-only cursor/clipboard and foreground probes before either
    // fixture window opens so any one-time helper build cannot disturb focus.
    currentStage = "prewarm_probes";
    getCursorClipboardState();
    recordForegroundCheckpoint(foregroundTimeline, "after_prewarm");

    currentStage = "launch_owned";
    const owned = structured(
      await call(local.client, "process", {
        op: "run",
        args: {
          program: "powershell.exe",
          args: [
            "-NoProfile",
            "-Sta",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            fixturePath,
            "-StatePath",
            ownedState,
            "-Title",
            `Tetherplane Owned ${framework} Fixture`,
            "-Prefix",
            "Owned",
            "-Framework",
            framework,
            "-NoActivate",
          ],
          wait_ms: 0,
          pty: false,
        },
      }),
    );
    ownedHandle = owned.handle as string;
    ownedPid = owned.pid as number;

    currentStage = "wait_owned_ready";
    const ownedReadyState = await waitForState(
      ownedState,
      (state) => isFixtureRenderedReady(state, framework),
      45_000,
    );
    recordForegroundCheckpoint(foregroundTimeline, "after_owned_ready");

    currentStage = "launch_human";
    humanProcess = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Sta",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fixturePath,
        "-StatePath",
        humanState,
        "-Title",
        `Tetherplane Human ${framework} Fixture`,
        "-Prefix",
        "Human",
        "-Framework",
        framework,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: false },
    );
    humanProcess.stdout?.on("data", (chunk: Buffer) => humanStdout.append(chunk));
    humanProcess.stderr?.on("data", (chunk: Buffer) => humanStderr.append(chunk));
    assert.ok(humanProcess.pid);
    humanPid = humanProcess.pid as number;

    currentStage = "wait_human_ready";
    await waitForState(
      humanState,
      (state) =>
        isFixtureRenderedReady(state, framework) && state.focused === true,
      45_000,
    );
    recordForegroundCheckpoint(foregroundTimeline, "after_human_ready");

    currentStage = "wait_owned_unfocused";
    const corroborated = await waitForCorroboratedFocusCoexistence({
      framework,
      ownedStatePath: ownedState,
      humanStatePath: humanState,
      ownedReadyState,
      ownedPid,
      humanPid,
      timeoutMs: 20_000,
    });
    const ownedBefore = corroborated.ownedState;
    assert.equal(ownedBefore.focused, false);
    assert.equal(corroborated.humanState.focused, true);
    assert.equal(corroborated.foreground.pid, humanPid);
    recordForegroundCheckpoint(foregroundTimeline, "after_owned_unfocused");
    focusCoexistenceSummary = {
      verdict: corroborated.verdict,
      owned_ready_seq: ownedReadyState.state_seq ?? null,
      owned_before_seq: ownedBefore.state_seq ?? null,
      owned_before_ticks: ownedBefore.tick_count ?? null,
      owned_hwnd: ownedBefore.hwnd ?? null,
      owned_window_is_active: ownedBefore.window_is_active ?? null,
      owned_focus_mismatch: ownedBefore.focus_mismatch ?? null,
      human_before_seq: corroborated.humanState.state_seq ?? null,
      human_before_ticks: corroborated.humanState.tick_count ?? null,
      human_hwnd: corroborated.humanState.hwnd ?? null,
      human_window_is_active: corroborated.humanState.window_is_active ?? null,
      human_focus_mismatch: corroborated.humanState.focus_mismatch ?? null,
      os_foreground: toForegroundRecord(corroborated.foreground),
    };

    currentStage = "snapshot";
    const snapshot = structured(
      await call(local.client, "desktop", {
        op: "snapshot",
        args: { max_nodes: 1000 },
      }),
    );
    const nodes = snapshot.nodes as DesktopNode[];
    const ownedNodes = nodes.filter((node) => node.process_id === ownedPid);
    const humanNodes = nodes.filter((node) => node.process_id === humanPid);
    ownedNodesSummary = summarizeNodesForDiagnostics(ownedNodes);
    humanNodesSummary = summarizeNodesForDiagnostics(humanNodes);
    assert.ok(ownedNodes.length > 0, `${framework} owned fixture was not observed`);
    assert.ok(humanNodes.length > 0, `${framework} human fixture was not observed`);
    assert.ok(ownedNodes.every((node) => node.origin === "tetherplane"));
    assert.ok(humanNodes.every((node) => node.origin === "human_or_external"));

    currentStage = "select_targets";
    const { valueNode, invokeNode, selectionNode, listBoxNode } =
      selectOwnedFixtureTargets(ownedNodes);
    selectedTargetsSummary = {
      value: summarizeNodesForDiagnostics([valueNode])[0],
      invoke: summarizeNodesForDiagnostics([invokeNode])[0],
      selection: selectionNode
        ? summarizeNodesForDiagnostics([selectionNode])[0]
        : null,
      listbox: listBoxNode
        ? summarizeNodesForDiagnostics([listBoxNode])[0]
        : null,
    };

    // Measure an explicit idle-control interval with zero Tetherplane calls to
    // distinguish external host/RDP cursor drift from provider-induced movement.
    currentStage = "idle_control";
    const idleBefore = recordCursorCheckpoint(
      cursorTimeline,
      "before_idle_control",
      null,
    ).state;
    await new Promise((resolve) =>
      setTimeout(resolve, IDLE_CONTROL_INTERVAL_MS),
    );
    const idleAfter = recordCursorCheckpoint(
      cursorTimeline,
      "after_idle_control",
      idleBefore,
    ).state;
    idleControlSummary = {
      duration_ms: IDLE_CONTROL_INTERVAL_MS,
      before: idleBefore.cursor,
      after: idleAfter.cursor,
      moved:
        idleAfter.cursor.x !== idleBefore.cursor.x ||
        idleAfter.cursor.y !== idleBefore.cursor.y,
      dx: idleAfter.cursor.x - idleBefore.cursor.x,
      dy: idleAfter.cursor.y - idleBefore.cursor.y,
    };

    const baselineCheckpoint = recordCursorCheckpoint(
      cursorTimeline,
      "before_actions",
      idleAfter,
    );
    baselineCursorState = baselineCheckpoint.state;
    const cursorBefore = baselineCursorState.cursor;
    const clipboardBefore = baselineCursorState.clipboardTextBase64;
    const humanBefore = await readState(humanState);
    assert.equal(humanBefore.focused, true);
    assert.equal(
      baselineCheckpoint.foreground?.pid,
      humanPid,
      `${framework} OS foreground drifted away from human fixture before actions: ${JSON.stringify(baselineCheckpoint.foreground)}`,
    );

    currentStage = "act_set_value";
    const valueResult = await call(local.client, "desktop", {
      op: "act",
      args: {
        reference: valueNode.reference,
        action: "set_value",
        value: "owned-semantic-value",
      },
    });
    actionEvidence.set_value = buildActionEvidence(
      "set_value",
      valueNode,
      valueResult,
    );
    const afterSetValueCheckpoint = recordCursorCheckpoint(
      cursorTimeline,
      "after_set_value",
      baselineCursorState,
    );
    assert.equal(
      valueResult.isError,
      undefined,
      `${framework} desktop.act(set_value) failed: ${JSON.stringify(actionEvidence.set_value)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      (await readState(humanState)).focused,
      true,
      `${framework} human fixture lost focus after semantic set_value`,
    );
    assert.equal(
      afterSetValueCheckpoint.foreground?.pid,
      humanPid,
      `${framework} OS foreground changed after semantic set_value: ${JSON.stringify(afterSetValueCheckpoint.foreground)}`,
    );

    currentStage = "act_invoke";
    const invokeResult = await call(local.client, "desktop", {
      op: "act",
      args: {
        reference: invokeNode.reference,
        action: "invoke",
      },
    });
    actionEvidence.invoke = buildActionEvidence(
      "invoke",
      invokeNode,
      invokeResult,
    );
    const afterInvokeCheckpoint = recordCursorCheckpoint(
      cursorTimeline,
      "after_invoke",
      baselineCursorState,
    );
    assert.equal(
      invokeResult.isError,
      undefined,
      `${framework} desktop.act(invoke) failed: ${JSON.stringify(actionEvidence.invoke)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      (await readState(humanState)).focused,
      true,
      `${framework} human fixture lost focus after semantic invoke`,
    );
    assert.equal(
      afterInvokeCheckpoint.foreground?.pid,
      humanPid,
      `${framework} OS foreground changed after semantic invoke: ${JSON.stringify(afterInvokeCheckpoint.foreground)}`,
    );

    currentStage = "act_select";
    if (framework === "Wpf" || selectionNode !== undefined) {
      assert.ok(
        selectionNode,
        `${framework} expected desktop node with selection pattern`,
      );
      const selectionResult = await call(local.client, "desktop", {
        op: "act",
        args: {
          reference: selectionNode.reference,
          action: "select",
        },
      });
      actionEvidence.select = buildActionEvidence(
        "select",
        selectionNode,
        selectionResult,
      );
      const afterSelectCheckpoint = recordCursorCheckpoint(
        cursorTimeline,
        "after_select",
        baselineCursorState,
      );
      assert.equal(
        selectionResult.isError,
        undefined,
        `${framework} desktop.act(select) failed: ${JSON.stringify(actionEvidence.select)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        (await readState(humanState)).focused,
        true,
        `${framework} human fixture lost focus after semantic select`,
      );
      assert.equal(
        afterSelectCheckpoint.foreground?.pid,
        humanPid,
        `${framework} OS foreground changed after semantic select: ${JSON.stringify(afterSelectCheckpoint.foreground)}`,
      );
    } else {
      assert.ok(
        listBoxNode,
        "expected WinForms selection node or listbox container",
      );
      const degradedSelect = await call(local.client, "desktop", {
        op: "act",
        args: {
          reference: listBoxNode.reference,
          action: "select",
        },
      });
      actionEvidence.select = buildActionEvidence(
        "select",
        listBoxNode,
        degradedSelect,
      );
      recordCursorCheckpoint(
        cursorTimeline,
        "after_select_degraded",
        baselineCursorState,
      );
      assert.equal(degradedSelect.isError, true);
      assert.equal(
        (structured(degradedSelect).error as Record<string, unknown>).code,
        "capability_unavailable",
      );
    }

    currentStage = "wait_owned_after";
    const expectSelectedBeta =
      framework === "Wpf" ||
      Boolean(selectionNode && selectionNode.name.includes("Beta"));
    const ownedAfter = await waitForState(
      ownedState,
      (state) =>
        state.text === "owned-semantic-value" &&
        state.status === "invoked" &&
        (!expectSelectedBeta || state.selected === "Owned Beta"),
    );
    assert.equal(ownedAfter.text, "owned-semantic-value");
    assert.equal(ownedAfter.status, "invoked");
    assert.equal(ownedAfter.focused, false);
    assert.ok(
      Number(ownedAfter.state_seq) > Number(ownedBefore.state_seq),
      `${framework} owned state_seq did not advance after actions (before=${String(ownedBefore.state_seq)}, after=${String(ownedAfter.state_seq)})`,
    );
    if (expectSelectedBeta) {
      assert.equal(ownedAfter.selected, "Owned Beta");
    }

    currentStage = "verify_coexistence";
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterActionsCheckpoint = recordCursorCheckpoint(
      cursorTimeline,
      "after_owned_verified",
      baselineCursorState,
    );
    const afterActionsState = afterActionsCheckpoint.state;
    assert.deepEqual(afterActionsState.cursor, cursorBefore);
    assert.equal(afterActionsState.clipboardTextBase64, clipboardBefore);
    const humanAfter = await readState(humanState);
    assert.equal(humanAfter.focused, true);
    assert.equal(humanAfter.text, "Human-initial");
    assert.equal(
      afterActionsCheckpoint.foreground?.pid,
      humanPid,
      `${framework} OS foreground was not human fixture at verify_coexistence: ${JSON.stringify(afterActionsCheckpoint.foreground)}`,
    );

    currentStage = "negative_human_act";
    const humanInvoke = selectHumanInvokeTarget(humanNodes);
    const deniedHuman = await call(local.client, "desktop", {
      op: "act",
      args: {
        reference: humanInvoke.reference,
        action: "invoke",
        origin: "tetherplane",
      },
    });
    assert.equal(deniedHuman.isError, true);
    assert.equal(
      (structured(deniedHuman).error as Record<string, unknown>).code,
      "permission_denied",
    );

    currentStage = "negative_stale_ref";
    const stale = await call(local.client, "desktop", {
      op: "act",
      args: {
        reference: "desk_ffffffffffffffff",
        action: "invoke",
      },
    });
    assert.equal(stale.isError, true);
    assert.equal(
      (structured(stale).error as Record<string, unknown>).code,
      "stale_reference",
    );

    currentStage = "private_clipboard";
    const privateSet = await call(local.client, "desktop", {
      op: "private_clipboard_set",
      args: {
        text: "private-e2e-value",
        files: [path.join(temp, "artifact.txt")],
      },
    });
    assert.equal(privateSet.isError, undefined);
    const privateGet = structured(
      await call(local.client, "desktop", {
        op: "private_clipboard_get",
        args: {},
      }),
    );
    assert.equal(privateGet.text, "private-e2e-value");
    const afterPrivateClipboard = recordCursorCheckpoint(
      cursorTimeline,
      "after_private_clipboard",
      baselineCursorState,
    ).state;
    assert.equal(afterPrivateClipboard.clipboardTextBase64, clipboardBefore);

    currentStage = "negative_no_lease";
    const noLease = await call(local.client, "desktop", {
      op: "physical_pointer_move",
      args: {
        lease_id: "00000000-0000-4000-8000-000000000000",
        target_resource: "pointer",
        x: cursorBefore.x,
        y: cursorBefore.y,
      },
    });
    assert.equal(noLease.isError, true);
    assert.equal(
      (structured(noLease).error as Record<string, unknown>).code,
      "foreground_lease_required",
    );
    const afterNoLease = recordCursorCheckpoint(
      cursorTimeline,
      "after_no_lease",
      baselineCursorState,
    ).state;
    assert.deepEqual(afterNoLease.cursor, cursorBefore);

    currentStage = "negative_self_mint";
    const selfMint = await call(local.client, "desktop", {
      op: "foreground_lease_acquire",
      args: {
        for_principal_id: "compact-mcp",
        target_resource: "pointer",
        capabilities: ["desktop.physical_pointer_move"],
        ttl_ms: 5000,
        reason: "AI must not self-mint foreground authority",
      },
    });
    assert.equal(selfMint.isError, true);
    assert.equal(
      (structured(selfMint).error as Record<string, unknown>).code,
      "permission_denied",
    );
    currentStage = "completed";
  } catch (error) {
    originalFailure = error;
    // The interactive failure may happen before the test harness can assert
    // on a fixture's state. Capture only this disposable fixture's state,
    // structured MCP responses, cursor/foreground timeline, and child output
    // before teardown; do not change policy or expose clipboard text.
    const failureFg = readForegroundForDiagnostics();
    const detail: Record<string, unknown> = {
      framework,
      stage: currentStage,
      owned_pid: ownedPid ?? null,
      human_pid: humanPid ?? null,
      error: String(error),
      focus_coexistence: focusCoexistenceSummary,
      foreground_at_failure: toForegroundRecord(failureFg.info),
      foreground_at_failure_error: failureFg.error ?? null,
      foreground_timeline: foregroundTimeline,
      idle_control: idleControlSummary,
      cursor_timeline: cursorTimeline,
      selected_targets: selectedTargetsSummary,
      action_evidence: actionEvidence,
      owned_nodes_summary: ownedNodesSummary,
      human_nodes_summary: humanNodesSummary,
    };
    for (const [label, statePath] of [
      ["owned_state", ownedState],
      ["human_state", humanState],
    ] as const) {
      try {
        detail[label] = await readState(statePath);
      } catch (readError) {
        detail[label + "_error"] = String(readError);
      }
      try {
        detail[label + "_startup_stage"] = await readFile(
          statePath + ".startup.txt",
          "utf8",
        );
      } catch (readError) {
        detail[label + "_startup_stage_error"] = String(readError);
      }
      try {
        detail[label + "_startup_error"] = await readFile(
          statePath + ".startup.txt.error.txt",
          "utf8",
        );
      } catch (readError) {
        detail[label + "_startup_error_unavailable"] = String(readError);
      }
    }
    if (ownedHandle) {
      try {
        const processResult = await call(local.client, "process", {
          op: "read",
          args: { handle: ownedHandle, mode: "tail", tail_bytes: 4096 },
        });
        detail.owned_process = extractToolPayload(processResult);
      } catch (processError) {
        detail.owned_process_error = String(processError);
      }
    }
    detail.human_process = {
      pid: humanPid ?? null,
      exit_code: humanProcess?.exitCode ?? null,
      signal_code: humanProcess?.signalCode ?? null,
      stdout: humanStdout.read(),
      stderr: humanStderr.read(),
    };
    console.error(
      formatTapSafeDiagnosticLine("G4_FIXTURE_FAILURE_CONTEXT=", detail),
    );
    throw error;
  } finally {
    const telemetry = {
      framework,
      outcome: originalFailure === undefined ? "pass" : "fail",
      stage: currentStage,
      owned_pid: ownedPid ?? null,
      human_pid: humanPid ?? null,
      focus_coexistence: focusCoexistenceSummary,
      foreground_timeline: foregroundTimeline,
      idle_control: idleControlSummary,
      cursor_before: baselineCursorState?.cursor ?? null,
      cursor_timeline: cursorTimeline,
      actions: Object.fromEntries(
        Object.entries(actionEvidence).map(([key, record]) => [
          key,
          {
            reference: record.target.reference,
            automation_id: record.target.automation_id,
            name: record.target.name,
            is_error: record.payload.is_error,
            transport: record.transport,
            verified: record.verified,
            error_code:
              typeof (record.payload.structured?.error as Record<string, unknown> | undefined)
                ?.code === "string"
                ? (record.payload.structured?.error as Record<string, unknown>)
                    .code
                : null,
          },
        ]),
      ),
    };
    console.log(
      formatTapSafeDiagnosticLine("G4_COEXISTENCE_TELEMETRY=", telemetry),
    );

    const cleanupErrors: string[] = [];
    let ownedStopped = ownedHandle === undefined;
    if (ownedHandle !== undefined) {
      // This child is a fixture we started, not a general system process.
      // Ask the fixture to close itself, rather than bypass process.terminate's
      // intentional approval_required policy. Never erase its directory first.
      try {
        await writeFile(ownedState + ".stop", "close\n", "utf8");
        for (let attempt = 0; attempt < 135; attempt += 1) {
          const read = await call(local.client, "process", {
            op: "read",
            args: { handle: ownedHandle, mode: "tail", tail_bytes: 1024 },
          });
          if (read.isError) {
            throw new Error("owned fixture status read rejected: " +
              JSON.stringify(extractToolPayload(read)));
          }
          const status = structured(read);
          if (status.running === false) {
            ownedStopped = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        if (!ownedStopped) {
          cleanupErrors.push("owned fixture did not observe cooperative stop signal");
        }
      } catch (error) {
        cleanupErrors.push("owned fixture: " + String(error));
      }
    }

    let humanStopped = !humanProcess?.pid;
    if (humanProcess?.pid) {
      try {
        humanStopped = await stopSpawnedFixture(humanProcess);
        humanProcess.stdout?.destroy();
        humanProcess.stderr?.destroy();
        if (!humanStopped) cleanupErrors.push("human fixture exit timed out");
      } catch (error) {
        cleanupErrors.push("human fixture: " + String(error));
      }
    }

    await local.close().catch((error: unknown) => {
      cleanupErrors.push("local MCP close: " + String(error));
    });
    if (ownedStopped && humanStopped) {
      await rm(temp, { recursive: true, force: true });
    } else {
      cleanupErrors.push("fixture processes not confirmed stopped; retained state directory " + temp);
    }
    if (cleanupErrors.length > 0) {
      const message = "G4 fixture teardown incomplete: " + cleanupErrors.join("; ");
      console.error(message);
      // Preserve the original assertion failure if one led to teardown.
      if (originalFailure === undefined) throw new Error(message);
    }
  }
}

// A noninteractive process-launch check, distinct from the full G4 UIA gate.
// It constructs and exits GUI fixtures without showing windows, moving a
// cursor, accessing the clipboard, or taking any foreground focus.
test(
  "Windows Compact MCP launches nonvisible WinForms and WPF fixture constructors",
  // GitHub-hosted Windows CI runs without an interactive desktop; GUI-backed
  // PowerShell may remain alive without entering its script under that host.
  // Direct constructor preflight runs in CI; MCP child GUI launches require
  // an interactive disposable Windows Sandbox or staging desktop.
  {
    skip: process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true",
    timeout: 180_000,
  },
  async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fixturePath = path.join(here, "fixtures", "windows-desktop-fixture.ps1");
    const local = await startLocalCompact();
    try {
      for (const framework of ["WinForms", "Wpf"] as const) {
        const statePath = path.join(local.root, "nonvisible-" + framework + ".json");
        const result = await call(local.client, "process", {
          op: "run",
          args: {
            program: "powershell.exe",
            args: [
              "-NoProfile", "-NonInteractive", "-Sta",
              "-ExecutionPolicy", "Bypass", "-File", fixturePath,
              "-StatePath", statePath, "-Title", "Nonvisible G4 MCP preflight",
              "-Prefix", "Owned", "-Framework", framework, "-InitializeOnly",
            ],
            wait_ms: 10000,
            pty: false,
          },
        });
        assert.equal(result.isError, undefined,
          framework + ": nonvisible process.run was denied");
        const processInfo = structured(result);
        assert.ok(typeof processInfo.handle === "string",
          framework + ": no owned process handle returned");

        // Establish that the same allowed process provider can launch a
        // non-GUI PowerShell command before attributing any stall to WPF.
        const canaryPath = path.join(local.root, "launch-canary-" + framework + ".txt");
        const canary = await call(local.client, "process", {
          op: "run",
          args: {
            program: "powershell.exe",
            args: [
              "-NoProfile", "-NonInteractive", "-Command",
              "[IO.File]::WriteAllText('" + canaryPath.replace(/'/g, "''") + "', 'canary-ok')",
            ],
            wait_ms: 5000,
            pty: false,
          },
        });
        const canaryResult = structured(canary);
        // process.run is allowed to return running=true before Windows has
        // started the child PowerShell. Do not misclassify that as failure.
        await waitForExactFile(canaryPath, "canary-ok", 30_000).catch(
          (error: unknown) => {
            throw new Error(framework + ": launch canary failed: " + String(error) +
              "; launch=" + JSON.stringify({
                pid: canaryResult.pid, running: canaryResult.running,
                exit_code: canaryResult.exit_code, stderr: canaryResult.stderr,
              }));
          },
        );
        let lastStage = "missing";
        let stageReached = false;
        let latestProcess: Record<string, unknown> = processInfo;
        const expected =
          framework === "WinForms"
            ? "stage=winforms-controls-created"
            : "stage=controls-created";
        for (let i = 0; i < 450; i += 1) {
          try {
            lastStage = await readFile(statePath + ".startup.txt", "utf8");
            if (lastStage.includes(expected)) {
              stageReached = true;
              break;
            }
          } catch {
            // Bootstrap may not have created its stage file yet.
          }
          if (i % 10 === 0) {
            const read = await call(local.client, "process", {
              op: "read",
              args: { handle: processInfo.handle, mode: "tail", tail_bytes: 2048 },
            });
            latestProcess = structured(read);
            if (latestProcess.running === false) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const launchedProcessDiagnostic = !stageReached ? powershell(
          "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " +
            String(processInfo.pid) + "' -ErrorAction SilentlyContinue;" +
          " if ($p) { $p | Select-Object ProcessId,ParentProcessId,Name," +
          "@{N='Executable';E={$_.ExecutablePath}} | ConvertTo-Json -Compress }" +
          " else { 'missing' }",
        ) : "not-needed";
        assert.equal(stageReached, true,
          framework + ": owned process did not initialize; last_stage=" + lastStage +
          "; process_cim=" + launchedProcessDiagnostic +
          "; child_status=" + JSON.stringify({
            pid: latestProcess.pid ?? processInfo.pid,
            running: latestProcess.running,
            exit_code: latestProcess.exit_code,
            stdout: latestProcess.stdout,
            stderr: latestProcess.stderr,
            terminal_reason: latestProcess.terminal_reason,
          }));
        assert.equal(await readFile(statePath, "utf8").then(
          () => true, () => false),
          false, framework + ": nonvisible fixture created a live window state");

        let stopped = processInfo.running === false;
        for (let i = 0; i < 200 && !stopped; i += 1) {
          const statusResult = await call(local.client, "process", {
            op: "read",
            args: { handle: processInfo.handle, mode: "tail", tail_bytes: 1024 },
          });
          assert.equal(statusResult.isError, undefined);
          stopped = structured(statusResult).running === false;
          if (!stopped) await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(stopped, true,
          framework + ": nonvisible fixture did not exit on its own");
        console.log("G4_" + framework.toUpperCase() + "_MCP_NONVISIBLE_STARTUP=PASS");
      }
    } finally {
      await local.close();
    }
  },
);

const skipInteractiveWindowsDesktop =
  // GitHub-hosted Windows runners do not provide the interactive desktop
  // required to certify UI Automation coexistence. This proof runs on
  // interactive non-production Windows hosts or Windows Sandbox.
  process.platform !== "win32" || process.env.GITHUB_ACTIONS === "true";

test(
  "Windows WinForms desktop coexists with a human window through Compact MCP",
  { skip: skipInteractiveWindowsDesktop, timeout: 180_000 },
  async () => {
    await runDesktopCoexistenceTest("WinForms");
  },
);

test(
  "Windows WPF desktop coexists with an unfocused owned window and human window through Compact MCP",
  { skip: skipInteractiveWindowsDesktop, timeout: 180_000 },
  async () => {
    await runDesktopCoexistenceTest("Wpf");
  },
);
