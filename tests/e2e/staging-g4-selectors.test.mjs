import assert from "node:assert/strict";
import test from "node:test";
import { selectStagingG4FixtureTargets, detectInteractiveWindowsDesktop } from "../../scripts/staging-acceptance.mjs";

const node = (automation_id, name, patterns, role = "edit") => ({
  automation_id,
  name,
  role,
  patterns,
  reference: `desk:${automation_id}`,
});

test("remote G4 resolves exact owned and human controls, never window chrome", () => {
  const owned = [
    node("TitleBarValue", "System", ["value"]),
    node("WindowClose", "Close", ["invoke"], "button"),
    node("OwnedValue", "Owned Value", ["value"]),
    node("OwnedInvoke", "Owned Invoke", ["invoke"], "button"),
    node("OwnedAlpha", "Owned Alpha", ["selection"], "list item"),
    node("OwnedBeta", "Owned Beta", ["selection"], "list item"),
    node("OwnedSelection", "Owned Selection", [], "list view"),
  ];
  const human = [
    node("WindowClose", "Close", ["invoke"], "button"),
    node("HumanInvoke", "Human Invoke", ["invoke"], "button"),
  ];
  const t = selectStagingG4FixtureTargets(owned, human);
  assert.equal(t.valueNode.automation_id, "OwnedValue");
  assert.equal(t.invokeNode.automation_id, "OwnedInvoke");
  assert.equal(t.selectionNode.automation_id, "OwnedBeta");
  assert.equal(t.listBoxNode.automation_id, "OwnedSelection");
  assert.equal(t.humanInvokeNode.automation_id, "HumanInvoke");
});

test("remote G4 supports degraded WinForms selection without selecting arbitrary controls", () => {
  const owned = [
    node("OwnedValue", "Owned Value", ["value"]),
    node("OwnedInvoke", "Owned Invoke", ["invoke"], "button"),
    node("OwnedSelection", "Owned Selection", [], "list view"),
    node("OtherAlpha", "Other Alpha", ["selection"], "list item"),
  ];
  const t = selectStagingG4FixtureTargets(owned, [
    node("HumanInvoke", "Human Invoke", ["invoke"], "button"),
  ]);
  assert.equal(t.selectionNode, null);
  assert.equal(t.listBoxNode.automation_id, "OwnedSelection");
});

test("remote G4 refuses to target a generic value or system button", () => {
  assert.throws(
    () => selectStagingG4FixtureTargets([
      node("TitleBarValue", "System", ["value"]),
      node("WindowClose", "Close", ["invoke"], "button"),
    ], [node("HumanInvoke", "Human Invoke", ["invoke"], "button")]),
    /OwnedValue must resolve uniquely/,
  );
});

test("remote G4 fails closed on ambiguous identity or missing human-owned control", () => {
  const owned = [
    node("OwnedValue", "Owned Value", ["value"]),
    node("OwnedValue", "Owned Value", ["value"]),
    node("OwnedInvoke", "Owned Invoke", ["invoke"], "button"),
  ];
  assert.throws(
    () => selectStagingG4FixtureTargets(owned, [
      node("HumanInvoke", "Human Invoke", ["invoke"], "button"),
    ]),
    /OwnedValue must resolve uniquely/,
  );
  assert.throws(
    () => selectStagingG4FixtureTargets(owned.slice(0, 1).concat(owned[2]), [
      node("WindowClose", "Close", ["invoke"], "button"),
    ]),
    /HumanInvoke must resolve uniquely/,
  );
});

test("Sandbox with missing SESSIONNAME verifies real input desktop",()=>{
  let calls=0;
  assert.equal(detectInteractiveWindowsDesktop({platform:"win32",githubActions:"false",sessionName:undefined,probe:()=>{calls++;return true}}),true);
  assert.equal(calls,1);
});
test("G4 desktop check fails closed on CI, services, Linux or probe denial",()=>{
  const base={platform:"win32",githubActions:"false",sessionName:undefined,probe:()=>true};
  assert.equal(detectInteractiveWindowsDesktop({...base,githubActions:"true"}),false);
  assert.equal(detectInteractiveWindowsDesktop({...base,sessionName:"Services"}),false);
  assert.equal(detectInteractiveWindowsDesktop({...base,platform:"linux"}),false);
  assert.equal(detectInteractiveWindowsDesktop({...base,probe:()=>false}),false);
  assert.equal(detectInteractiveWindowsDesktop({...base,probe:()=>{throw Error("denied")}}),false);
  assert.equal(detectInteractiveWindowsDesktop({...base,sessionName:"Console",probe:()=>{throw Error("no call")}}),true);
});
