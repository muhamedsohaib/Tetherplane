import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRequire } from "node:module";
const WebSocket=createRequire(new URL("../../../relay/package.json",import.meta.url))("ws");
import { OAuthPortal } from "../oauth.mjs";
import { provisionAuthorityAudit } from "../authority-audit.mjs";
import { RelayServer } from "../../../relay/src/server.ts";
import { StaticClientAuthenticator } from "../../../relay/src/auth/static-auth.ts";
import { hashDeviceCredential } from "../../../relay/src/devices/registry.ts";

const issuer="https://issuer.test.invalid/";
const resource="https://relay.test.invalid/mcp";
const ownerToken=["eyJhbGciOiJSUzI1NiJ9",
  Buffer.from(JSON.stringify({iss:issuer,sub:"existing-owner-subject",aud:resource,
    scope:"tetherplane:access",exp:3000000000})).toString("base64url"),
  "nonproduction-signature"].join(".");
const owner={accountId:"existing-owner-account",clientId:"existing-owner-portal-client",principalId:"human:owner"};
const ai={accountId:owner.accountId,clientId:"existing-chat-client",principalId:"human:owner"};
const outside={...ai,clientId:"other-unapproved-client"};
const htmlPath=fileURLToPath(new URL("../public/index.html",import.meta.url));
const knownHtmlHash="4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8";

function invocation(deviceId,capability) {
 return {protocol_version:"1.0",request_id:"v5-owner-portal-interop-"+Math.random(),
   device_id:deviceId,principal_id:null,job_id:null,capability,arguments:{},
   actor:{id:"untrusted",kind:"ai_client"},session_id:null,response_mode:"compact",
   idempotency_key:null,preconditions:[],expectations:[]};
}

test("V5 owner editor + real loopback relay require both identities; Leno only + rollback",async t=>{
  const html=await readFile(htmlPath);
  assert.equal(createHash("sha256").update(html).digest("hex"),knownHtmlHash,
    "User-approved private V5 HTML must remain unmodified");
  const folder=await mkdtemp(path.join(os.tmpdir(),"tp-v5-owner-auth-boundary-"));
  const websockets=[];
  const registryState=path.join(folder,"registry.json");
  const ownerState=path.join(folder,"owner.json");
  await writeFile(ownerState,JSON.stringify({version:1,revision:0,enabled:false,grants:[]})+"\n");
  const auth=new StaticClientAuthenticator([
    {...owner,token:ownerToken},
    {...ai,token:"synthetic-ai-token"},
    {...outside,token:"synthetic-other-token"},
  ]);
  const relay=await RelayServer.create({
    authenticator:auth,allowInsecureLocalhost:true,
    stateFile:registryState,ownerAuthority:{owner,stateFile:ownerState}
  });
  const addr=await relay.listen({host:"127.0.0.1",port:0});
  const audit={
    journalPath:path.join(folder,"audit.jsonl"),
    checkpointPath:path.join(folder,"checkpoint.json"),
    auditKey:Buffer.alloc(32,6).toString("base64"),
    issuer,resource,adminSubjects:["existing-owner-subject"]
  };
  provisionAuthorityAudit(audit);
  const portal=new OAuthPortal({relayUrl:addr.httpUrl,authority:audit,htmlPath});
  const origin=await portal.listen(0);
  const sessionId="synthetic-owner-portal-session";
  const csrf="synthetic-portal-csrf";
  portal.sessions.set(sessionId,{token:ownerToken,csrf,expires:Date.now()+120000});
  let cookie=portal.cookieName+"="+sessionId;
  t.after(async()=>{
    for(const ws of websockets)ws.terminate();
    await portal.close();await relay.close();
    await rm(folder,{recursive:true,force:true});
  });
  for(const deviceId of ["Leno","Surface","RTX","VAULTER"]){
    const credential="synthetic-v5-e2e-"+deviceId;
    const pending=await relay.registry.startPairing({
      deviceId,credentialHash:hashDeviceCredential(credential)});
    await relay.registry.approvePairing({accountId:owner.accountId,userCode:pending.userCode});
    const socket=new WebSocket(addr.deviceWsUrl,{headers:{
      authorization:"Device "+credential,"x-tetherplane-device-id":deviceId}});
    websockets.push(socket);
    socket.on("message",raw=>{
      const msg=JSON.parse(String(raw));
      if(msg.type!=="invoke")return;
      socket.send(JSON.stringify({type:"result",routeId:msg.routeId,result:{
        protocol_version:"1.0",request_id:msg.invocation.request_id,status:"success",
        data:msg.invocation.capability==="device.capabilities"
          ? {providers:[
              {namespace:"device",available:true,operations:["status","capabilities"]},
              {namespace:"filesystem",available:true,operations:["info","read"]},
              {namespace:"process",available:true,operations:["run"]},
              {namespace:"desktop",available:true,operations:["snapshot"]},
              {namespace:"browser",available:false,operations:[]}
            ]}
          : {deviceId,capability:msg.invocation.capability},
        delta:null,
        error:null,policy:null,verification:"not_applicable",continuation:null,
        timing:{duration_ms:1}
      }}));
    });
    await once(socket,"open");
  }
  const identity=await auth.authenticate("synthetic-ai-token");
  assert.ok(identity);
  assert.equal((await relay.router.call(identity,invocation("Leno","device.status"))).status,"success",
    "An authenticated request registers this exact client as observed");
  const post=async(route,body,opts={})=>{
    const resp=await fetch(origin+route,{method:"POST",headers:{
      cookie,origin,
      "content-type":"application/json",
      ...(!opts.omitCsrf?{"x-csrf-token":csrf}:{}),
    },body:JSON.stringify(body)});
    return {status:resp.status,body:await resp.json()};
  };
  const get=async(route)=>{
    const resp=await fetch(origin+route,{headers:{cookie}});
    return {status:resp.status,body:await resp.json()};
  };
  assert.equal((await get("/api/authority/Leno")).status,200,
    "Existing V5 audited inspection still works");
  const initial=await get("/api/owner-leno");
  assert.equal(initial.status,200);
  assert.deepEqual(initial.body.enforcedDevices,[]);
  assert.ok(initial.body.clients.some(c=>c.clientId===ai.clientId));
  // A stale owner cookie must never stage privileges, even if its CSRF token remains known.
  const stale=portal.sessions.get(sessionId);
  assert.ok(stale);
  stale.expires=Date.now()-1;
  const expired=await post("/api/owner-leno/grant",{
    revision:0,clientId:ai.clientId,principalId:ai.principalId,confirmation:"TRUST Leno"
  });
  assert.equal(expired.status,401,"Expired owner session must be denied");
  // Simulate an explicitly reauthenticated owner session, without minting any real token.
  const freshSessionId="synthetic-owner-renewed-session";
  portal.sessions.set(freshSessionId,{token:ownerToken,csrf,expires:Date.now()+120000});
  cookie=portal.cookieName+"="+freshSessionId;
  const afterRenew=await get("/api/owner-leno");
  assert.equal(afterRenew.status,200);
  assert.equal(afterRenew.body.revision,0,"Denied stale session must not stage the grant");
  assert.equal((await post("/api/owner-leno/grant",{
    revision:0,clientId:ai.clientId,principalId:ai.principalId,confirmation:"TRUST Leno"
  },{omitCsrf:true})).status,403);
  const staged=await post("/api/owner-leno/grant",{
    revision:0,clientId:ai.clientId,principalId:ai.principalId,confirmation:"TRUST Leno"
  });
  assert.equal(staged.status,200);
  assert.equal(staged.body.revision,1);
  const enforced=await post("/api/owner-leno/enforcement",{
    revision:1,enabled:true,confirmation:"ENFORCE Leno GRANTS"
  });
  assert.equal(enforced.status,200);
  assert.deepEqual((await get("/api/owner-leno")).body.enforcedDevices,["Leno"]);
  const otherIdentity=await auth.authenticate("synthetic-other-token");
  assert.ok(otherIdentity);
  assert.equal((await relay.router.call(otherIdentity,invocation("Leno","device.status"))).error?.code,"permission_denied");
  assert.equal((await relay.router.call(identity,invocation("Leno","process.run"))).status,"success");
  for(const deviceId of ["Surface","RTX","VAULTER"]){
    assert.equal((await relay.router.call(otherIdentity,invocation(deviceId,"device.status"))).status,"success",deviceId);
  }
  assert.equal((await get("/api/authority/Leno")).status,200,
    "Original V5 inspection and audit must remain operational after new grant");
  const restored=await post("/api/owner-leno/enforcement",{
    revision:2,enabled:false,confirmation:"RESTORE Leno LEGACY ACCESS"
  });
  assert.equal(restored.status,200);
  assert.deepEqual((await get("/api/owner-leno")).body.enforcedDevices,[]);
  assert.equal((await relay.router.call(otherIdentity,invocation("Leno","device.status"))).status,"success");
  assert.equal(createHash("sha256").update(await readFile(htmlPath)).digest("hex"),knownHtmlHash);
});
