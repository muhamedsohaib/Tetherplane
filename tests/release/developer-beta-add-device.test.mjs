import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {mkdtemp,mkdir,copyFile,readFile,writeFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {stage,validatePublicRelay} from "../../scripts/developer-beta/stage-beta-wizard.mjs";
import {verifyCandidate} from "../../packaging/developer-beta/preflight.mjs";

const repo=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const source=join(repo,"packaging","msix-store-runtime","app");
async function createStage(t){
 const scratch=await mkdtemp(join(tmpdir(),"tp-owner-beta-test-"));
 const app=join(scratch,"app");
 await mkdir(app);
 for(const name of ["runtime-app.mjs","setup.html","setup.css","setup-client.js","state-security.mjs"]){
  const src=await readFile(join(source,name),"utf8");
  await writeFile(join(app,name),
   name==="state-security.mjs"?src:stage(name,src,"wss://relay.example.test/device"),"utf8");
 }
 t.after(()=>rm(scratch,{force:true,recursive:true,maxRetries:5,retryDelay:150}));
 return {scratch,app,runtime:await import(pathToFileURL(join(app,"runtime-app.mjs")).href)};
}
function bearer(wizard){const u=new URL(wizard.url);return {origin:u.origin,token:u.hash.slice(1)}}
async function request(wizard,route,method="GET",body,headers={}){
 const {origin,token}=bearer(wizard);
 return fetch(origin+route,{
   method,redirect:"manual",
   headers:{"x-tetherplane-setup":token,...(method==="POST"?{"origin":origin,"content-type":"application/json"}:{}),...headers},
   body:method==="POST"?JSON.stringify(body??{}):undefined
 });
}
function fakeAgent(){
 const p=new EventEmitter();
 p.exitCode=null;
 p.stderr={resume(){}};
 p.kill=()=>{p.exitCode=0;p.emit("exit",0);return true};
 return p;
}
const challenge=()=>({userCode:"ABCD-1234",pairingId:"review-only",expiresAt:new Date(Date.now()+600_000).toISOString()});

test("beta source contract separates state, limits agent to one owner, and gives honest status",async t=>{
 const {app}=await createStage(t);
 const runtime=await readFile(join(app,"runtime-app.mjs"),"utf8");
 const html=await readFile(join(app,"setup.html"),"utf8");
 const client=await readFile(join(app,"setup-client.js"),"utf8");
 for(const file of ["runtime-app.mjs","setup-client.js"]){
  const run=spawnSync(process.execPath,["--check",join(app,file)],{encoding:"utf8",timeout:8000});
  assert.equal(run.status,0,run.stderr);
 }
 assert.match(runtime,/TetherplaneDeveloperBeta/);
 assert.match(runtime,/owner-instance-lock/);
 assert.match(runtime,/tetherd-agentw\.exe/);
 assert.doesNotMatch(html,/Store-certified\. Do not use it to replace|TETHERPLANE · DEVELOPMENT PREVIEW/);
 assert.match(html,/Device Authority/);
 assert.match(html,/value="wss:\/\/relay\.example\.test\/device"/);
 assert.match(client,/setInterval\(tryOwnerApprovedStart,2500\)/);
 assert.match(html,/Stop ends this session/);
 assert.doesNotMatch(html,/Automatically approved/);
});

test("relay presets reject insecure, credential-bearing or ambiguous URLs",()=>{
 assert.equal(validatePublicRelay(""),"");
 assert.equal(validatePublicRelay("wss://relay.example.test/device"),"wss://relay.example.test/device");
 for(const url of ["ws://relay.example.test/device","https://relay.example.test/device",
  "wss://user:password@relay.example.test/device",
  "wss://relay.example.test/device?token=123","wss://relay.example.test/not-device",
  " wss://relay.example.test/device"]){
  assert.throws(()=>validatePublicRelay(url));
 }
});

test("local approval wizard creates only the explicitly proposed shared folder; refuses unapproved agent startup",async t=>{
 const {scratch,runtime}=await createStage(t);
 const stateRoot=join(scratch,"secure-state");
 const share=join(scratch,"Tetherplane Shared");
 const packageRoot=join(scratch,"package");
 await mkdir(join(packageRoot,"bin"),{recursive:true});
 await writeFile(join(packageRoot,"bin","tetherd-agentw.exe"),"SYNTHETIC_NOT_EXECUTED");
 const calls=[],starts=[];
 let approved=false;
 const wizard=await runtime.createWizard({
  stateRoot,packageRoot,suggestedAllowRoot:share,
  fetchImpl:async(uri,options)=>{
   calls.push({url:uri,body:JSON.parse(options.body),method:options.method});
   return new Response(JSON.stringify(challenge()),{status:200,headers:{"content-type":"application/json"}});
  },
  approvalProbe:async()=>approved,
  spawnAgent:(exe,args,options)=>{starts.push({exe,args,options});return fakeAgent()}
 });
 t.after(()=>wizard.close());
 const idle=await (await request(wizard,"/api/status")).json();
 assert.equal(idle.suggestedAllowRoot,share);
 await assert.rejects(()=>stat(share),{code:"ENOENT"});
 const noToken=await fetch(bearer(wizard).origin+"/api/status");
 assert.equal(noToken.status,403);
 const premature=await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"});
 assert.equal(premature.status,400);
 const hostile=await request(wizard,"/api/pair","POST",{deviceId:"test-device",relayUrl:"wss://relay.example.test/device",allowRoot:share},{origin:"https://other.example.test"});
 assert.equal(hostile.status,403);
 await assert.rejects(()=>stat(share),{code:"ENOENT"});
 const start=await request(wizard,"/api/pair","POST",{deviceId:"tp-new-tester-123",relayUrl:"wss://relay.example.test/device",allowRoot:share});
 assert.equal(start.status,200);
 assert.equal((await stat(share)).isDirectory(),true);
 const approvedWithoutRelay=await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"});
 assert.equal(approvedWithoutRelay.status,400);
 assert.equal(starts.length,0);
 await assert.rejects(()=>stat(stateRoot),{code:"ENOENT"});
 approved=true;
 const connected=await request(wizard,"/api/start","POST",{confirmation:"I APPROVED THIS DEVICE"});
 assert.equal(connected.status,200);
 assert.equal((await connected.json()).connected,"not_verified");
 assert.equal(starts.length,1);
 assert.ok(starts[0].exe.endsWith("tetherd-agentw.exe"));
 assert.ok(starts[0].args.includes("--owner-instance-lock"));
 assert.ok(starts[0].args.includes("--allow"));
 assert.equal(starts[0].args[starts[0].args.indexOf("--allow")+1],share);
 assert.equal(calls[0].url,"https://relay.example.test/pair/start");
 assert.match(calls[0].body.credentialHash,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(calls).includes("Authorization"),false);
 const stop=await request(wizard,"/api/stop","POST",{});
 assert.equal(stop.status,200);
});

test("integrity check catches tampering and exact allowlist changes",async t=>{
 const root=await mkdtemp(join(tmpdir(),"tp-beta-integrity-"));
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:150}));
 const files=["bin/tetherd-agentw.exe","bin/tetherplane-setupw.exe","runtime/node.exe",
  "runtime/LICENSE.node.txt","app/preflight.mjs","app/runtime-app.mjs","app/state-security.mjs",
  "app/setup.html","app/setup-client.js","app/setup.css",
  "app/assets/brand-32.png","app/assets/brand-128.png","START HERE.cmd"];
 const hashes={};
 for(const file of files){
  const p=join(root,...file.split("/"));
  await mkdir(dirname(p),{recursive:true});
  const content="synthetic fixture "+file;
  await writeFile(p,content);
  hashes[file]=createHash("sha256").update(content).digest("hex");
 }
 const metadata={schema:"tetherplane.developer-beta.package.v1",source_commit:"a".repeat(40),file_hashes:hashes};
 await writeFile(join(root,"developer-beta.json"),JSON.stringify(metadata));
 assert.equal((await verifyCandidate(root)).files_verified,files.length);
 await writeFile(join(root,"app","runtime-app.mjs"),"tampered");
 await assert.rejects(()=>verifyCandidate(root),/integrity check failed/);
});


test("customer wizard preserves single-instance protection and explains saved identity", async t=>{
 const {app}=await createStage(t);
 const html=await readFile(join(app,"setup.html"),"utf8");
 const client=await readFile(join(app,"setup-client.js"),"utf8");
 assert.match(client,/agentLocallyRunning/);
 assert.match(client,/markAgentRunning/);
 assert.match(client,/resumeStart"\)\.disabled=true/);
 assert.match(client,/if\(agentLocallyRunning\)/);
 assert.match(client,/This wizard already owns a running agent/);
 assert.match(client,/Agent running locally/);
 assert.doesNotMatch(client,/remote connection verified successfully/);
 assert.match(html,/saved, owner-approved Tetherplane identity/);
 assert.doesNotMatch(html,/Existing Store-preview credentials will be preserved/);
});

test("generated customer wizard JavaScript runs with mocked local saved-agent state", async t=>{
 const {app}=await createStage(t);
 const source=await readFile(join(app,"setup-client.js"),"utf8");
 const vm=await import("node:vm");
 const elements={};
 const handlers={};
 for(const id of ["setup","feedback","code","status","start","resumeStart","stop","challenge","resume","blocked","waiting","copyCode"]){
   elements[id]={disabled:false,hidden:false,textContent:"",addEventListener:(event,fn)=>{handlers[id+":"+event]=fn}};
 }
 elements.setup.deviceId={value:""};
 elements.setup.allowRoot={value:""};
 const calls=[];
 const ctx={
   document:{getElementById:id=>elements[id]},
   location:{hash:"#test-setup-token",pathname:"/"},
   history:{replaceState(){}},
   crypto:{randomUUID:()=>"12345678-0000-4000-8000-000000000000"},
   fetch:async(path,opts)=>{
     calls.push(path);
     if(path==="/api/status")return {ok:true,json:async()=>({state:"agent_started_not_verified",hasSavedIdentity:true,identityBlocked:false})};
     if(path==="/api/start")throw Error("Unexpected duplicate agent start");
     throw Error("Unexpected request "+path);
   },
   navigator:{clipboard:{writeText:async()=>{}}},
   FormData:class {},
   setInterval(){return 0},
   Date,Error,JSON,String,Promise,Object
 };
 vm.runInNewContext(source,ctx,{timeout:1500});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(elements.resumeStart.disabled,true);
 assert.equal(elements.start.disabled,true);
 assert.match(elements.status.textContent,/Agent running locally/);
 await handlers["resumeStart:click"]();
 assert.equal(calls.filter(x=>x==="/api/start").length,0);
});
