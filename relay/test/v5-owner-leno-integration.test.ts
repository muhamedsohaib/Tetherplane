import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { InvocationEnvelope } from "@tetherplane/protocol";
import { RelayServer } from "../src/server.ts";
import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";
import { hashDeviceCredential } from "../src/devices/registry.ts";

const owner = { accountId:"owner-v5", clientId:"existing-verified-owner-portal", principalId:"human:owner" };
const ai = { accountId:"owner-v5", clientId:"existing-chatgpt-client", principalId:"human:owner" };
const other = {...ai, clientId:"unknown-other-client"};

function invocation(device:string, capability:string, args:Record<string,unknown>={}):InvocationEnvelope {
  return { protocol_version:"1.0", request_id:"leno-test-"+Math.random(), device_id:device,
    principal_id:null,job_id:null,capability,arguments:args,
    actor:{id:"untrusted-input",kind:"ai_client"},session_id:null,response_mode:"compact",
    idempotency_key:null,preconditions:[],expectations:[] };
}

async function fixture(t:import("node:test").TestContext) {
  const dir=await mkdtemp(path.join(os.tmpdir(),"tp-v5-leno-owner-"));
  const stateFile=path.join(dir,"owner-state.json");
  await writeFile(stateFile,JSON.stringify({version:1,revision:0,enabled:false,grants:[]})+"\n");
  const auth=new StaticClientAuthenticator([
    {...owner,token:"synthetic-owner-token"},{...ai,token:"synthetic-ai-token"},
    {...other,token:"synthetic-other-token"},
  ]);
  const relay=await RelayServer.create({
    authenticator:auth,allowInsecureLocalhost:true,ownerAuthority:{owner,stateFile}
  });
  const addr=await relay.listen({host:"127.0.0.1",port:0});
  const websockets:WebSocket[]=[];
  t.after(async()=>{
    for(const ws of websockets)ws.terminate();
    await relay.close();await rm(dir,{recursive:true,force:true});
  });
  const paired=new Map<string,string>();
  const calls=new Map<string,number>();
  for(const device of ["Leno","Surface","RTX","VAULTER"]){
    const credential="synthetic-auth-device-"+device;
    const pending=await relay.registry.startPairing({
      deviceId:device,credentialHash:hashDeviceCredential(credential)
    });
    const pairing=await relay.registry.approvePairing({accountId:owner.accountId,userCode:pending.userCode});
    paired.set(device,pairing.pairedAt);
    const ws=new WebSocket(addr.deviceWsUrl,{headers:{
      authorization:"Device "+credential,"x-tetherplane-device-id":device}});
    websockets.push(ws);
    ws.on("message",raw=>{
      const m=JSON.parse(String(raw));
      if(m.type!=="invoke")return;
      calls.set(device,(calls.get(device)||0)+1);
      ws.send(JSON.stringify({type:"result",routeId:m.routeId,result:{
        protocol_version:"1.0",request_id:m.invocation.request_id,status:"success",
        data:{target:device,clientId:m.invocation.actor.id,capability:m.invocation.capability},
        delta:null,error:null,policy:null,verification:"not_applicable",continuation:null,
        timing:{duration_ms:1},
      }}));
    });
    await once(ws,"open");
  }
  for(let i=0;i<50;i++){
    if(["Leno","Surface","RTX","VAULTER"].every(d=>relay.router.isOnline(d)))break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(["Leno","Surface","RTX","VAULTER"].every(d=>relay.router.isOnline(d)),true);
  async function api(route:string,token:string|null="synthetic-owner-token",method="GET",body?:Record<string,unknown>) {
    const response=await fetch(addr.httpUrl+route,{method,headers:{
      ...(token?{authorization:"Bearer "+token}:{}),
      ...(body?{"content-type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const text=await response.text();
    return {status:response.status,data:text?JSON.parse(text):null};
  }
  return {relay,api,paired,calls};
}

test("V5 owner opt-in cannot affect other devices, exact client binding and rollback",async t=>{
  const f=await fixture(t);
  assert.equal((await f.api("/owner/leno",null)).status,403);
  assert.equal((await f.api("/owner/leno","synthetic-ai-token")).status,403);
  const snapshot=await f.api("/owner/leno");
  assert.equal(snapshot.status,200);
  assert.equal(snapshot.data.enabled,false);
  assert.deepEqual(snapshot.data.enforcedDevices,[]);
  // Until configured, legacy access remains unchanged even on Leno.
  assert.equal((await f.relay.router.call(other,invocation("Leno","device.status"))).status,"success");
  // Observing an authenticated ChatGPT client requires a real routed call.
  assert.equal((await f.relay.router.call(ai,invocation("Surface","device.status"))).status,"success");
  const grant={revision:0,clientId:ai.clientId,principalId:ai.principalId,confirmation:"TRUST Leno"};
  assert.equal((await f.api("/owner/leno/grant","synthetic-other-token","POST",grant)).status,403);
  assert.equal((await f.api("/owner/leno/grant",null,"POST",grant)).status,403);
  assert.equal((await f.api("/owner/leno/grant",undefined,"POST",{...grant,confirmation:"YES"})).status,400);
  const stage=await f.api("/owner/leno/grant",undefined,"POST",grant);
  assert.equal(stage.status,200);
  assert.equal(stage.data.revision,1);
  assert.equal((await f.api("/owner/leno/grant",undefined,"POST",grant)).status,409);
  const enabled=await f.api("/owner/leno/enforcement",undefined,"POST",{
    revision:1,enabled:true,confirmation:"ENFORCE Leno GRANTS"});
  assert.equal(enabled.status,200);
  const state=(await f.api("/owner/leno")).data;
  assert.equal(state.enabled,false);
  assert.deepEqual(state.enforcedDevices,["Leno"]);
  assert.equal(state.grants.length,1);
  const before=f.calls.get("Leno")??0;
  const denied=await f.relay.router.call(other,invocation("Leno","device.status"));
  assert.equal(denied.error?.code,"permission_denied");
  assert.equal(f.calls.get("Leno"),before);
  assert.equal((await f.relay.router.call(ai,invocation("Leno","process.run"))).status,"success");
  assert.equal((await f.relay.router.call(ai,invocation("Leno","unreviewed.future"))).error?.code,"permission_denied");
  assert.equal((await f.relay.router.call(ai,invocation("Leno","batch.execute",{
    mode:"sequential",operations:[{capability:"process.run"},{capability:"unreviewed.future"}]
  }))).error?.code,"permission_denied");
  for(const d of ["Surface","RTX","VAULTER"]){
    assert.equal((await f.relay.router.call(other,invocation(d,"process.run"))).status,"success",d);
  }
  const rollback=await f.api("/owner/leno/enforcement",undefined,"POST",{
    revision:2,enabled:false,confirmation:"RESTORE Leno LEGACY ACCESS"});
  assert.equal(rollback.status,200);
  assert.deepEqual((await f.api("/owner/leno")).data.enforcedDevices,[]);
  assert.equal((await f.relay.router.call(other,invocation("Leno","device.status"))).status,"success");
});

test("V5 owner state is unmodified with no opt-in, legacy URLs and routing remain valid",async t=>{
  const f=await fixture(t);
  assert.equal((await f.api("/devices","synthetic-ai-token")).status,200);
  assert.equal((await f.api("/owner/leno/unknown")).status,404);
  assert.equal((await f.api("/owner/leno/grant",undefined,"GET")).status,405);
  assert.equal((await f.api("/owner/leno/enforcement",undefined,"POST",{
    revision:0,enabled:true,confirmation:"ENFORCE Leno GRANTS"
  })).status,403);
  for(const d of ["Surface","Leno","RTX","VAULTER"])
    assert.equal((await f.relay.router.call(ai,invocation(d,"device.status"))).status,"success",d);
});
