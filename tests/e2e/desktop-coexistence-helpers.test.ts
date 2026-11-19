import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  type FixtureStateSnapshot,
} from "./helpers/desktop-coexistence-helpers.ts";

function makeNode(overrides: Partial<DesktopNode> & { reference: string; name: string }): DesktopNode {
  return {
    role: "custom",
    automation_id: null,
    class_name: null,
    process_id: 5000,
    origin: "tetherplane",
    enabled: true,
    focusable: true,
    focused: false,
    patterns: [],
    ...overrides,
  };
}

test("selectOwnedFixtureTargets skips Win32 non-client TitleBar and window chrome buttons before WPF controls", () => {
  // Real WPF HwndSource ControlViewWalker ordering exposes Win32 non-client
  // TitleBar (ValuePattern) and Minimize/Maximize/Close (InvokePattern) BEFORE
  // the WPF StackPanel children (OwnedValue, OwnedInvoke, OwnedSelection).
  const wpfOwnedNodes: DesktopNode[] = [
    makeNode({
      reference: "desk_0001",
      role: "window",
      name: "Owned Form",
      automation_id: "OwnedForm",
      class_name: "Window",
      patterns: [],
    }),
    makeNode({
      reference: "desk_0002",
      role: "title bar",
      name: "",
      automation_id: "TitleBar",
      class_name: null,
      patterns: ["value"],
    }),
    makeNode({
      reference: "desk_0003",
      role: "button",
      name: "Minimize",
      automation_id: "Minimize",
      class_name: null,
      patterns: ["invoke"],
    }),
    makeNode({
      reference: "desk_0004",
      role: "button",
      name: "Maximize",
      automation_id: "Maximize",
      class_name: null,
      patterns: ["invoke"],
    }),
    makeNode({
      reference: "desk_0005",
      role: "button",
      name: "Close",
      automation_id: "Close",
      class_name: null,
      patterns: ["invoke"],
    }),
    makeNode({
      reference: "desk_0006",
      role: "edit",
      name: "Owned Value",
      automation_id: "OwnedValue",
      class_name: "TextBox",
      patterns: ["value"],
    }),
    makeNode({
      reference: "desk_0007",
      role: "button",
      name: "Owned Invoke",
      automation_id: "OwnedInvoke",
      class_name: "Button",
      patterns: ["invoke"],
    }),
    makeNode({
      reference: "desk_0008",
      role: "list",
      name: "Owned Selection",
      automation_id: "OwnedSelection",
      class_name: "ListBox",
      patterns: [],
    }),
    makeNode({
      reference: "desk_0009",
      role: "list item",
      name: "Owned Alpha",
      automation_id: "OwnedAlpha",
      class_name: "ListBoxItem",
      patterns: ["selection"],
    }),
    makeNode({
      reference: "desk_0010",
      role: "list item",
      name: "Owned Beta",
      automation_id: "OwnedBeta",
      class_name: "ListBoxItem",
      patterns: ["selection"],
    }),
  ];

  const targets = selectOwnedFixtureTargets(wpfOwnedNodes);
  assert.equal(targets.valueNode.reference, "desk_0006");
  assert.equal(targets.valueNode.automation_id, "OwnedValue");
  assert.equal(targets.invokeNode.reference, "desk_0007");
  assert.equal(targets.invokeNode.automation_id, "OwnedInvoke");
  assert.equal(targets.selectionNode?.reference, "desk_0010");
  assert.equal(targets.listBoxNode?.reference, "desk_0008");
});

test("selectOwnedFixtureTargets works for WinForms controls exposed as Pane with native class names", () => {
  const winformsOwnedNodes: DesktopNode[] = [
    makeNode({
      reference: "desk_0101",
      role: "pane",
      name: "Owned Value",
      automation_id: "OwnedValue",
      class_name: "WindowsForms10.EDIT.app.0.141b42a_r7_ad1",
      patterns: ["value"],
    }),
    makeNode({
      reference: "desk_0102",
      role: "pane",
      name: "Owned Invoke",
      automation_id: "OwnedInvoke",
      class_name: "WindowsForms10.BUTTON.app.0.141b42a_r7_ad1",
      patterns: ["invoke"],
    }),
    makeNode({
      reference: "desk_0103",
      role: "list",
      name: "Owned Selection",
      automation_id: "OwnedSelection",
      class_name: "WindowsForms10.LISTBOX.app.0.141b42a_r7_ad1",
      patterns: [],
    }),
    makeNode({
      reference: "desk_0104",
      role: "list item",
      name: "Owned Beta",
      automation_id: null,
      class_name: null,
      patterns: ["selection"],
    }),
  ];

  const targets = selectOwnedFixtureTargets(winformsOwnedNodes);
  assert.equal(targets.valueNode.reference, "desk_0101");
  assert.equal(targets.invokeNode.reference, "desk_0102");
  assert.equal(targets.selectionNode?.reference, "desk_0104");
  assert.equal(targets.listBoxNode?.reference, "desk_0103");
});

test("selectOwnedFixtureTargets rejects TitleBar and window chrome buttons when fixture controls are missing", () => {
  const onlyChrome: DesktopNode[] = [
    makeNode({
      reference: "desk_0201",
      role: "title bar",
      name: "",
      automation_id: "TitleBar",
      patterns: ["value"],
    }),
    makeNode({
      reference: "desk_0202",
      role: "button",
      name: "Minimize",
      automation_id: "Minimize",
      patterns: ["invoke"],
    }),
  ];

  assert.throws(
    () => selectOwnedFixtureTargets(onlyChrome),
    /OwnedValue|value/i,
  );
});

test("selectHumanInvokeTarget selects HumanInvoke instead of Minimize/Close chrome buttons", () => {
  const humanNodes: DesktopNode[] = [
    makeNode({
      reference: "desk_0301",
      role: "button",
      name: "Minimize",
      automation_id: "Minimize",
      process_id: 6000,
      origin: "human_or_external",
      patterns: ["invoke"],
    }),
    makeNode({
      reference: "desk_0302",
      role: "button",
      name: "Human Invoke",
      automation_id: "HumanInvoke",
      process_id: 6000,
      origin: "human_or_external",
      patterns: ["invoke"],
    }),
  ];

  const target = selectHumanInvokeTarget(humanNodes);
  assert.equal(target.reference, "desk_0302");
  assert.equal(target.automation_id, "HumanInvoke");
});

test("extractToolPayload preserves structured errors and raw text without throwing", () => {
  assert.deepEqual(
    extractToolPayload({
      isError: true,
      structuredContent: {
        error: { code: "action_unverified", message: "unfocused control" },
      },
    }),
    {
      is_error: true,
      structured: {
        error: { code: "action_unverified", message: "unfocused control" },
      },
      raw_text: null,
    },
  );

  assert.deepEqual(
    extractToolPayload({
      isError: true,
      content: [{ type: "text", text: "plain-text failure from tool" }],
    }),
    {
      is_error: true,
      structured: null,
      raw_text: "plain-text failure from tool",
    },
  );
});

test("summarizeNodesForDiagnostics and bounded output collector preserve metadata safely", () => {
  const summary = summarizeNodesForDiagnostics([
    makeNode({
      reference: "desk_0401",
      role: "edit",
      name: "Owned Value",
      automation_id: "OwnedValue",
      class_name: "TextBox",
      patterns: ["value"],
    }),
  ]);
  assert.deepEqual(summary, [
    {
      reference: "desk_0401",
      role: "edit",
      name: "Owned Value",
      automation_id: "OwnedValue",
      class_name: "TextBox",
      patterns: ["value"],
      enabled: true,
      focused: false,
    },
  ]);

  const collector = createBoundedOutputCollector(8);
  collector.append("12345");
  collector.append("67890");
  assert.equal(collector.read(), "34567890");
});

function makeFixtureState(
  overrides: Partial<FixtureStateSnapshot> = {},
): FixtureStateSnapshot {
  return {
    ready: true,
    content_rendered: true,
    focused: false,
    window_is_active: false,
    window_is_keyboard_focus_within: false,
    hwnd: 1001,
    os_foreground_available: true,
    os_foreground_hwnd: 2002,
    os_foreground_pid: 1068,
    os_foreground_matches_window: false,
    os_foreground_matches_process: false,
    focus_mismatch: false,
    state_seq: 2,
    tick_count: 1,
    activated_events: 0,
    deactivated_events: 0,
    write_errors: 0,
    last_write_error: null,
    last_source: "timer",
    updated_at_utc: "2026-11-18T22:00:00.0000000Z",
    text: "Owned-initial",
    selected: "Owned Alpha",
    status: "idle",
    pid: 3516,
    framework: "Wpf",
    ...overrides,
  };
}

test("isFixtureRenderedReady rejects pre-ContentRendered timer ticks and accepts rendered snapshots", () => {
  assert.equal(
    isFixtureRenderedReady(
      makeFixtureState({
        ready: true,
        content_rendered: false,
        state_seq: 1,
      }),
      "Wpf",
    ),
    false,
  );
  assert.equal(
    isFixtureRenderedReady(
      makeFixtureState({
        ready: false,
        content_rendered: false,
        state_seq: 1,
      }),
      "Wpf",
    ),
    false,
  );
  assert.equal(
    isFixtureRenderedReady(
      makeFixtureState({
        ready: true,
        content_rendered: true,
        state_seq: 0,
      }),
      "Wpf",
    ),
    false,
  );
  assert.equal(
    isFixtureRenderedReady(
      makeFixtureState({
        framework: "WinForms",
      }),
      "Wpf",
    ),
    false,
  );
  assert.equal(
    isFixtureRenderedReady(
      makeFixtureState({
        ready: true,
        content_rendered: true,
        state_seq: 1,
        framework: "Wpf",
      }),
      "Wpf",
    ),
    true,
  );
});

test("hasFixtureHeartbeatAdvanced detects frozen state files and accepts monotonic timer updates", () => {
  const initial = makeFixtureState({ state_seq: 1, tick_count: 0 });
  assert.equal(
    hasFixtureHeartbeatAdvanced(
      initial,
      makeFixtureState({ state_seq: 1, tick_count: 0 }),
    ),
    false,
  );
  assert.equal(
    hasFixtureHeartbeatAdvanced(
      initial,
      makeFixtureState({ state_seq: 2, tick_count: 0 }),
    ),
    false,
  );
  assert.equal(
    hasFixtureHeartbeatAdvanced(
      initial,
      makeFixtureState({ state_seq: 2, tick_count: 1 }),
    ),
    true,
  );
});

test("evaluateFocusCoexistence rejects dual-focused contradiction from af02b58 WPF failure", () => {
  const ownedState = makeFixtureState({
    pid: 3516,
    hwnd: 1001,
    focused: true,
    window_is_active: true,
    os_foreground_hwnd: 2002,
    os_foreground_pid: 1068,
    os_foreground_matches_window: false,
    focus_mismatch: true,
  });
  const humanState = makeFixtureState({
    pid: 1068,
    hwnd: 2002,
    focused: true,
    window_is_active: true,
    os_foreground_hwnd: 2002,
    os_foreground_pid: 1068,
    os_foreground_matches_window: true,
    os_foreground_matches_process: true,
  });

  const verdict = evaluateFocusCoexistence({
    framework: "Wpf",
    ownedState,
    humanState,
    ownedPid: 3516,
    humanPid: 1068,
    foreground: {
      hwnd: 2002,
      pid: 1068,
      processName: "powershell",
      className: "HwndWrapper[powershell.exe;;1]",
    },
  });

  assert.equal(verdict.ready, false);
  assert.equal(verdict.reason, "dual_focused_discrepancy");
  assert.ok(verdict.discrepancy?.includes("both"));
});

test("evaluateFocusCoexistence rejects stale owned focused=false when OS foreground is actually owned PID", () => {
  const ownedState = makeFixtureState({
    pid: 3516,
    hwnd: 1001,
    focused: false,
    os_foreground_hwnd: 2002,
    os_foreground_pid: 1068,
    os_foreground_matches_window: false,
  });
  const humanState = makeFixtureState({
    pid: 1068,
    hwnd: 2002,
    focused: true,
    os_foreground_hwnd: 2002,
    os_foreground_pid: 1068,
    os_foreground_matches_window: true,
    os_foreground_matches_process: true,
  });

  const verdict = evaluateFocusCoexistence({
    framework: "Wpf",
    ownedState,
    humanState,
    ownedPid: 3516,
    humanPid: 1068,
    foreground: {
      hwnd: 1001,
      pid: 3516,
      processName: "powershell",
      className: "HwndWrapper[powershell.exe;;owned]",
    },
  });

  assert.equal(verdict.ready, false);
  assert.equal(verdict.reason, "os_foreground_is_owned");
  assert.ok(verdict.discrepancy);
});

test("evaluateFocusCoexistence rejects missing or third-party OS foreground window", () => {
  const ownedState = makeFixtureState({ pid: 3516, hwnd: 1001, focused: false });
  const humanState = makeFixtureState({
    pid: 1068,
    hwnd: 2002,
    focused: true,
    os_foreground_hwnd: 2002,
    os_foreground_pid: 1068,
    os_foreground_matches_window: true,
    os_foreground_matches_process: true,
  });

  const missingFg = evaluateFocusCoexistence({
    framework: "Wpf",
    ownedState,
    humanState,
    ownedPid: 3516,
    humanPid: 1068,
    foreground: null,
  });
  assert.equal(missingFg.ready, false);
  assert.equal(missingFg.reason, "os_foreground_unavailable");

  const otherFg = evaluateFocusCoexistence({
    framework: "Wpf",
    ownedState,
    humanState,
    ownedPid: 3516,
    humanPid: 1068,
    foreground: {
      hwnd: 9999,
      pid: 4444,
      processName: "explorer",
      className: "Shell_TrayWnd",
    },
  });
  assert.equal(otherFg.ready, false);
  assert.equal(otherFg.reason, "os_foreground_not_human");
});

test("evaluateFocusCoexistence passes only when both fixtures and independent OS foreground agree", () => {
  const ownedState = makeFixtureState({
    pid: 3516,
    hwnd: 1001,
    focused: false,
    window_is_active: false,
    os_foreground_hwnd: 2002,
    os_foreground_pid: 1068,
    os_foreground_matches_window: false,
    os_foreground_matches_process: false,
  });
  const humanState = makeFixtureState({
    pid: 1068,
    hwnd: 2002,
    focused: true,
    window_is_active: true,
    os_foreground_hwnd: 2002,
    os_foreground_pid: 1068,
    os_foreground_matches_window: true,
    os_foreground_matches_process: true,
  });

  const verdict = evaluateFocusCoexistence({
    framework: "Wpf",
    ownedState,
    humanState,
    ownedPid: 3516,
    humanPid: 1068,
    foreground: {
      hwnd: 2002,
      pid: 1068,
      processName: "powershell",
      className: "HwndWrapper[powershell.exe;;human]",
    },
  });

  assert.equal(verdict.ready, true);
  assert.equal(verdict.reason, "corroborated");
  assert.equal(verdict.discrepancy, null);
});

test("windows-desktop-fixture.ps1 enforces read-only OS foreground inspection, non-activating WPF mode, and no forbidden focus/input APIs", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.join(here, "fixtures", "windows-desktop-fixture.ps1");
  const source = readFileSync(fixturePath, "utf8");

  assert.match(source, /\[switch\]\$NoActivate/);
  assert.match(source, /\[switch\]\$SelfTestTimer/);
  assert.match(source, /\$window\.ShowActivated\s*=\s*\$false/);
  assert.match(source, /\$window\.Show\(\)/);
  assert.match(source, /\[System\.Windows\.Threading\.Dispatcher\]::Run\(\)/);
  assert.doesNotMatch(source, /\$window\.ShowDialog\(\)/);
  assert.match(source, /GetForegroundWindow/);
  assert.match(source, /GetWindowThreadProcessId/);
  assert.match(source, /MoveFileExW/);
  assert.match(source, /state_seq/);
  assert.match(source, /tick_count/);
  assert.match(source, /content_rendered/);
  assert.match(source, /updated_at_utc/);
  assert.match(source, /focus_mismatch/);
  assert.doesNotMatch(
    source,
    /\b(SetForegroundWindow|SetCursorPos|SendInput|mouse_event|keybd_event|AttachThreadInput)\b/,
  );
});

test("formatTapSafeDiagnosticLine emits valid single-line JSON with zero backslashes or hashes even for nested AssertionError payloads", () => {
  const nestedEvidence = {
    action: "set_value",
    payload: {
      is_error: true,
      structured: {
        error: {
          code: "action_unverified",
          message:
            "semantic desktop action altered foreground focus in background_only mode",
          details: {
            target_process_id: 3632,
            foreground_pid_before: 2856,
            foreground_pid_after: 3632,
          },
        },
      },
      raw_text: '{"error":{"code":"action_unverified"}}',
    },
    transport: null,
    verified: null,
  };
  let caught: unknown;
  try {
    assert.equal(
      true,
      undefined,
      `Wpf desktop.act(set_value) failed: ${JSON.stringify(nestedEvidence)}`,
    );
  } catch (error) {
    caught = error;
  }

  const detail = {
    framework: "Wpf",
    stage: "act_set_value",
    owned_pid: 3632,
    human_pid: 2856,
    error: String(caught),
    owned_state_startup_stage: "content-rendered\r\n",
    windows_path: "C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\Temp\\state.json",
    hash_note: "PR #153 check \x1b[31mred\x1b[0m \uD800 tail",
    action_evidence: { set_value: nestedEvidence },
  };

  const line = formatTapSafeDiagnosticLine(
    "G4_FIXTURE_FAILURE_CONTEXT=",
    detail,
  );
  assert.ok(line.startsWith("G4_FIXTURE_FAILURE_CONTEXT="));
  const jsonPart = line.slice("G4_FIXTURE_FAILURE_CONTEXT=".length);
  assert.equal(jsonPart.includes("\\"), false, "JSON must contain no backslashes");
  assert.equal(jsonPart.includes("#"), false, "JSON must contain no '#' characters");
  assert.equal(jsonPart.includes("\n"), false, "JSON must be single-line");
  assert.equal(jsonPart.includes("\r"), false, "JSON must contain no CR");

  const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
  assert.equal(parsed.framework, "Wpf");
  assert.equal(parsed.stage, "act_set_value");
  assert.equal(parsed.owned_pid, 3632);
  assert.equal(parsed.human_pid, 2856);
  assert.equal(
    parsed.windows_path,
    "C:/Users/WDAGUtilityAccount/AppData/Local/Temp/state.json",
  );
  const ev = (parsed.action_evidence as Record<string, unknown>)
    .set_value as Record<string, unknown>;
  const errObj = (
    (ev.payload as Record<string, unknown>).structured as Record<string, unknown>
  ).error as Record<string, unknown>;
  assert.equal(errObj.code, "action_unverified");
});

test("formatTapSafeDiagnosticLine survives node --test --test-reporter=tap without corrupting JSON", () => {
  let caught: unknown;
  try {
    const nested = {
      payload: {
        text: '{"error":{"code":"action_unverified"}}',
      },
    };
    assert.equal(
      true,
      undefined,
      `Wpf desktop.act(set_value) failed: ${JSON.stringify(nested)}`,
    );
  } catch (error) {
    caught = error;
  }

  const failurePayloadLine = formatTapSafeDiagnosticLine(
    "G4_FIXTURE_FAILURE_CONTEXT=",
    {
      framework: "Wpf",
      stage: "act_set_value",
      error: String(caught),
      path: "C:\\Users\\WDAGUtilityAccount\\Temp\\fixture.json",
      tag: "PR #153",
    },
  );
  const telemetryPayloadLine = formatTapSafeDiagnosticLine(
    "G4_COEXISTENCE_TELEMETRY=",
    {
      framework: "Wpf",
      outcome: "fail",
      tag: "#153",
    },
  );

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "tp-tap-json-"));
  const testFile = path.join(tempDir, "tap-repro.test.mjs");
  try {
    writeFileSync(
      testFile,
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'test("emits tap-safe json on failure", () => {',
        "  try {",
        '    assert.equal(true, undefined, "forced failure");',
        "  } catch (error) {",
        `    console.error(${JSON.stringify(failurePayloadLine)});`,
        "    throw error;",
        "  } finally {",
        `    console.log(${JSON.stringify(telemetryPayloadLine)});`,
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );

    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", testFile],
      { encoding: "utf8", env: childEnv },
    );
    assert.notEqual(run.status, 0);
    const combined = `${run.stdout}\n${run.stderr}`;
    const lines = combined.split(/\r?\n/);

    const failureLine = lines.find((line) =>
      line.includes("G4_FIXTURE_FAILURE_CONTEXT="),
    );
    const telemetryLine = lines.find((line) =>
      line.includes("G4_COEXISTENCE_TELEMETRY="),
    );
    assert.ok(failureLine, `missing failure context line in TAP output:\n${combined}`);
    assert.ok(telemetryLine, `missing telemetry line in TAP output:\n${combined}`);

    const parsedFailure = JSON.parse(
      failureLine.split("G4_FIXTURE_FAILURE_CONTEXT=", 2)[1] ?? "",
    ) as Record<string, unknown>;
    assert.equal(parsedFailure.framework, "Wpf");
    assert.equal(parsedFailure.stage, "act_set_value");
    assert.equal(
      parsedFailure.path,
      "C:/Users/WDAGUtilityAccount/Temp/fixture.json",
    );
    assert.equal(parsedFailure.tag, "PR (hash)153");

    const parsedTelemetry = JSON.parse(
      telemetryLine.split("G4_COEXISTENCE_TELEMETRY=", 2)[1] ?? "",
    ) as Record<string, unknown>;
    assert.equal(parsedTelemetry.framework, "Wpf");
    assert.equal(parsedTelemetry.outcome, "fail");
    assert.equal(parsedTelemetry.tag, "(hash)153");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
