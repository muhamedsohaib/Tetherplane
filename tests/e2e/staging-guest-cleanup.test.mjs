import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOverallOutcome, resetStagingGuestClipboard } from "../../scripts/staging-acceptance.mjs";

test("G4 guest clipboard reset uses STA Clear and readback, never focus/input",()=>{
  const calls=[];
  resetStagingGuestClipboard((program,args,options)=>{
    calls.push({program,args,options});
    return "G4_GUEST_CLIPBOARD_CLEAR=PASS\n";
  });
  assert.equal(calls.length,1);
  assert.equal(calls[0].program,"powershell.exe");
  assert.ok(calls[0].args.includes("-Sta"));
  const script=calls[0].args.at(-1);
  assert.match(script,/Clipboard\]::Clear\(\)/);
  assert.match(script,/Clipboard\]::ContainsText\(\)/);
  assert.match(script,/\$attempt -lt 5/);
  assert.doesNotMatch(script,/Set-Clipboard|Cursor|SetForegroundWindow|SendInput|SendKeys/i);
  assert.ok(calls[0].options.timeout <= 12000);
});
test("G4 guest clipboard reset refuses absent marker and preserves error evidence",()=>{
  assert.throws(()=>resetStagingGuestClipboard(()=>""),/not verified/);
  assert.throws(()=>resetStagingGuestClipboard(()=>{
    throw Object.assign(new Error("failed"),{stderr:"clipboard busy"});
  }),/clipboard busy/);
});
test("staging outcome never accepts unexecuted gates even with allowPartial",()=>{
  const gates={G1:{status:"PASS"},G2:{status:"PASS"},G3:{status:"PASS"},
    G4:{status:"PENDING"},G5:{status:"PENDING"},G6:{status:"BLOCKED"},G7:{status:"PASS"}};
  const r=evaluateOverallOutcome({allowPartial:true,gates});
  assert.equal(r.ok,false);
  assert.deepEqual(r.failed,["G4","G5"]);
  assert.deepEqual(r.blocked,["G6"]);
});
test("explicitly blocked mobile gate is allowed only when all runnable gates pass",()=>{
  const gates=Object.fromEntries(["G1","G2","G3","G4","G5","G7"].map(x=>[x,{status:"PASS"}]));
  gates.G6={status:"BLOCKED"};
  assert.equal(evaluateOverallOutcome({allowPartial:true,gates}).ok,true);
  assert.equal(evaluateOverallOutcome({allowPartial:false,gates}).ok,false);
});
