import assert from "node:assert/strict";
import test from "node:test";

import {
  createBoundedOutputCollector,
  extractToolPayload,
  selectHumanInvokeTarget,
  selectOwnedFixtureTargets,
  summarizeNodesForDiagnostics,
  type DesktopNode,
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
