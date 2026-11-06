import test from "node:test";
import assert from "node:assert/strict";
import {classify, summary, validateArgs} from "../../scripts/browser-owner-stability.mjs";

test("acceptance requires exact origin without path, credentials or fragments",()=>{
  assert.deepEqual(validateArgs(["--expected-origin=https://fixture.example","--cycles=20"]),
    {origin:"https://fixture.example",cycles:20,intervalMs:1000});
  for (const origin of [
    "https://fixture.example/private","https://fixture.example?session=1",
    "https://u:p@fixture.example","file:///C:/private",
    "https://fixture.example/#fragment","https://fixture.example/",
  ]) assert.throws(()=>validateArgs(["--expected-origin="+origin]));
  assert.throws(()=>validateArgs(["--expected-origin=https://fixture.example","--cycles=1000"]));
  assert.throws(()=>validateArgs(["--expected-origin=https://fixture.example","--interval-ms=0"]));
});

test("success requires array-shaped semantic nodes",()=>{
  assert.equal(classify({status:"success",data:{nodes:[{secret:"not logged"}]}}),"success");
  assert.equal(classify({status:"success",data:{content:"x"}}),"invalid_response");
  assert.equal(classify({status:"error",error:{code:"timeout"}}),"timeout");
  assert.equal(classify({status:"error",error:{code:"provider_busy"}}),"provider_busy");
  assert.equal(classify({status:"error",error:{code:"permission_denied"}}),"permission_denied");
  assert.equal(classify({status:"error",error:{code:"secret XYZ"}}),"other_error");
});

test("summary emits only counts/timings and no supplied browser fields",()=>{
  const input=[
    {kind:"success",duration_ms:20,content:"PRIVATE"},
    {kind:"timeout",duration_ms:5001,secret:"CREDENTIAL"},
    {kind:"success",duration_ms:40,url:"https://private.example/session"},
  ];
  const result=summary(input);
  assert.deepEqual(result,{
    attempted:3,successful:2,failures:1,errors:{timeout:1},
    latency_ms:{p50:20,p95:40,max:40},
  });
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.ok(!JSON.stringify(result).includes("CREDENTIAL"));
  assert.ok(!JSON.stringify(result).includes("private.example"));
});

test("suspended tabs are reported separately from timeouts",()=>{
  assert.equal(classify({status:"error",error:{code:"tab_suspended"}}),"tab_suspended");
});
