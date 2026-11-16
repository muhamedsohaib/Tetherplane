import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {runInNewContext} from "node:vm";
import {fileURLToPath} from "node:url";
import {resolve,dirname,join} from "node:path";
import {stage} from "../../scripts/developer-beta/stage-beta-wizard.mjs";

const repo=resolve(dirname(fileURLToPath(import.meta.url)),"../..");

async function renderSetup({state,hasSavedIdentity=true,identityBlocked=false,duplicateStart=false}) {
 const original=await readFile(join(repo,"packaging/msix-store-runtime/app/setup-client.js"),"utf8");
 const client=stage("setup-client.js",original,"wss://relay.example.test/device");
 const nodes=new Map();
 const requests=[];
 const intervals=[];
 function node(id){
  if(!nodes.has(id)) {
   nodes.set(id,{textContent:"",hidden:false,disabled:false,
    handlers:{},addEventListener(type,fn){this.handlers[type]=fn;}});
  }
  return nodes.get(id);
 }
 const form=node("setup");
 form.deviceId={value:""};
 form.allowRoot={value:""};
 const doc={getElementById:node};
 const response=async(route)=>{
  requests.push(route);
  if(route==="/api/status")return {
   ok:true,
   async json(){return {state,hasSavedIdentity,identityBlocked,
    lastError:null,suggestedAllowRoot:"C:\\Test\\Tetherplane Shared",connected:"not_verified"};}
  };
  if(route==="/api/start" && duplicateStart)return {
   ok:false,
   async json(){return {error:"This wizard already owns a running agent."};}
  };
  throw Error("Unexpected simulated route: "+route);
 };
 runInNewContext(client,{
  document:doc,fetch:response,location:{hash:"#synthetic",pathname:"/"},
  history:{replaceState(){}},crypto:{randomUUID(){return "12345678-0000-4000-8000-000000000000";}},
  setInterval(fn,delay){intervals.push({fn,delay});return intervals.length;},
  navigator:{clipboard:{async writeText(){}}}
 },{timeout:2000});
 await new Promise(setImmediate);
 return {nodes,requests,intervals};
}

test("running agent is clearly local, not falsely shown as offline, and resume is hidden",async()=>{
 const {nodes,requests}=await renderSetup({state:"agent_started_not_verified"});
 assert.match(nodes.get("status").textContent,/Agent running on this computer/);
 assert.match(nodes.get("status").textContent,/owner to verify remote device\.status/);
 assert.doesNotMatch(nodes.get("status").textContent,/\bonline\b|connected successfully/i);
 assert.equal(nodes.get("resume").hidden,true);
 assert.equal(nodes.get("resumeStart").disabled,true);
 assert.equal(nodes.get("start").disabled,true);
 assert.equal(nodes.get("challenge").hidden,true);
 assert.deepEqual(requests,["/api/status"],"Polling may not start a second agent");
});

test("stopped saved identity can resume without replacing credentials",async()=>{
 const {nodes,requests}=await renderSetup({state:"stopped"});
 assert.equal(nodes.get("resume").hidden,false);
 assert.equal(nodes.get("resumeStart").disabled,false);
 assert.match(nodes.get("status").textContent,/remote connectivity is not checked by this setup page/);
 assert.deepEqual(requests,["/api/status"]);
});

test("duplicate start race is explained without claiming remote authentication",async()=>{
 const {nodes}=await renderSetup({state:"stopped",duplicateStart:true});
 await nodes.get("resumeStart").handlers.click();
 await new Promise(setImmediate);
 assert.match(nodes.get("feedback").textContent,/already running locally/);
 assert.match(nodes.get("status").textContent,/owner to verify remote device\.status/);
 assert.equal(nodes.get("resume").hidden,true);
 assert.equal(nodes.get("resumeStart").disabled,true);
});

test("blocked existing identity still hides agent controls and preserves denial",async()=>{
 const {nodes,requests}=await renderSetup({state:"existing_identity_blocked",identityBlocked:true});
 assert.equal(nodes.get("blocked").hidden,false);
 assert.equal(nodes.get("resume").hidden,true);
 assert.equal(nodes.get("stop").hidden,true);
 assert.equal(nodes.get("setup").hidden,true);
 assert.deepEqual(requests,["/api/status"]);
});
