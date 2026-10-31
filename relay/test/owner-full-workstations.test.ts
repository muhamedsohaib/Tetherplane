import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { InvocationEnvelope } from "@tetherplane/protocol";
import type { ClientIdentity } from "../src/auth/static-auth.ts";
import { OwnerDeviceAuthority } from "../src/access/owner-authority.ts";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";

const portal: ClientIdentity = {accountId:"owner-account",clientId:"existing-owner-management",principalId:"human:owner"};
const chat: ClientIdentity = {accountId:"owner-account",clientId:"existing-chatgpt-client",principalId:"human:operator"};
const differentClient: ClientIdentity = {...chat,clientId:"another-oauth-client"};
const outsider: ClientIdentity = {...chat,accountId:"someone-else"};
const computers=["Surface","Leno","VAULTER","RTX"] as const;

function invocation(capability:string, args:Record<string,unknown>={}):InvocationEnvelope {
  return {
    protocol_version:"1.0",request_id:"owner-full-test",device_id:"RTX",
    principal_id:chat.principalId,job_id:null,capability,arguments:args,
    actor:{id:chat.clientId,kind:"ai_client"},session_id:null,response_mode:"compact",
    idempotency_key:null,preconditions:[],expectations:[],
  };
}
async function setup(t:import("node:test").TestContext){
  const root=await mkdtemp(path.join(os.tmpdir(),"tetherplane-owner-full-"));
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  const registry=await DeviceRegistry.open({stateFile:path.join(root,"registry.json")});
  const paired=new Map<string,string>();
  for(const name of computers){
    const pending=await registry.startPairing({
      deviceId:name, credentialHash:hashDeviceCredential("test-device-credential-"+name),
    });
    const entry=await registry.approvePairing({accountId:portal.accountId,userCode:pending.userCode});
    paired.set(name,entry.pairedAt);
  }
  const stateFile=path.join(root,"owner-authority.json");
  await writeFile(stateFile,JSON.stringify({version:1,revision:0,enabled:false,grants:[]})+"\n");
  const authority=await OwnerDeviceAuthority.open({owner:portal,registry,stateFile});
  const grants=computers.map(deviceId=>({
    deviceId,clientId:chat.clientId,principalId:chat.principalId,level:"full",
  }));
  return {registry,paired,stateFile,authority,grants};
}
function allowed(authority:OwnerDeviceAuthority,client:ClientIdentity,device:string,pairedAt:string,capability:string,args:Record<string,unknown>={}){
  return authority.evaluate(client,device,pairedAt,invocation(capability,args)).allowed;
}

test("Full Control is exact owner-approved, never a general default or wildcard",async t=>{
  const f=await setup(t);
  assert.equal(f.authority.snapshot(portal).enabled,false);
  assert.deepEqual(f.authority.snapshot(portal).levels,["blocked","observe","operate","full"]);
  assert.throws(()=>f.authority.snapshot(chat),/only the explicitly configured owner/);
  await assert.rejects(()=>f.authority.replaceGrants(chat,{revision:0,grants:f.grants}),/only the explicitly configured owner/);
  await assert.rejects(()=>f.authority.replaceGrants(portal,{revision:0,grants:f.grants}),/already authenticated and observed/);
  f.authority.observeClient(chat);
  await f.authority.replaceGrants(portal,{revision:0,grants:f.grants});
  await f.authority.setEnabled(portal,{revision:1,enabled:true,confirmation:"ENFORCE DEVICE GRANTS"});
  const caps=[
    "device.status","device.capabilities","filesystem.read","filesystem.write",
    "filesystem.move","search.start","process.run","process.input","process.terminate",
    "browser.status","browser.act","desktop.snapshot","desktop.act",
    "desktop.private_clipboard_set","desktop.foreground_lease_acquire",
    "desktop.foreground_lease_release","desktop.physical_pointer_move",
    "job.create","job.get","audit.read",
  ];
  for(const device of computers){
    const at=f.paired.get(device)!;
    for(const cap of caps)assert.equal(allowed(f.authority,chat,device,at,cap),true,device+" "+cap);
    assert.equal(allowed(f.authority,chat,device,at,"future.secret.machine_override"),false);
    assert.equal(allowed(f.authority,differentClient,device,at,"device.status"),false);
    assert.equal(allowed(f.authority,outsider,device,at,"device.status"),false);
    assert.equal(allowed(f.authority,chat,device,"2000-01-01T00:00:00Z","device.status"),false);
  }
  const persisted=JSON.parse(await readFile(f.stateFile,"utf8"));
  assert.equal(persisted.grants.length,4);
  assert.equal(persisted.grants.every((g:any)=>g.level==="full"),true);
  assert.equal(JSON.stringify(persisted).includes("test-device-credential"),false);
  const reopened=await OwnerDeviceAuthority.open({owner:portal,registry:f.registry,stateFile:f.stateFile});
  assert.equal(allowed(reopened,chat,"VAULTER",f.paired.get("VAULTER")!,"browser.act"),true);
});

test("Full Control batch children are checked individually, never via a wildcard",async t=>{
  const f=await setup(t);
  f.authority.observeClient(chat);
  await f.authority.replaceGrants(portal,{revision:0,grants:f.grants});
  await f.authority.setEnabled(portal,{revision:1,enabled:true,confirmation:"ENFORCE DEVICE GRANTS"});
  const at=f.paired.get("RTX")!;
  const batch=(capabilities:string[])=>invocation("batch.execute",{
    mode:"sequential",operations:capabilities.map(capability=>({capability,arguments:{}})),
  });
  assert.equal(f.authority.evaluate(chat,"RTX",at,batch(["process.run","desktop.act"])).allowed,true);
  assert.equal(f.authority.evaluate(chat,"RTX",at,batch(["process.run","future.privileged"])).allowed,false);
  assert.equal(f.authority.evaluate(chat,"RTX",at,batch(["batch.execute"])).allowed,false);
  assert.equal(f.authority.evaluate(differentClient,"RTX",at,batch(["process.run"])).allowed,false);
});

test("full rights vanish on device revoke/re-pair; unowned device cannot be granted",async t=>{
  const f=await setup(t);
  f.authority.observeClient(chat);
  await assert.rejects(()=>f.authority.replaceGrants(portal,{revision:0,grants:[
    ...f.grants,{deviceId:"unpaired",clientId:chat.clientId,principalId:chat.principalId,level:"full"}
  ]}),/not currently owned/);
  await f.authority.replaceGrants(portal,{revision:0,grants:f.grants});
  await f.authority.setEnabled(portal,{revision:1,enabled:true,confirmation:"ENFORCE DEVICE GRANTS"});
  await f.registry.revokeDevice({accountId:portal.accountId,deviceId:"VAULTER"});
  await f.authority.revokeGrants("VAULTER");
  const pending=await f.registry.startPairing({deviceId:"VAULTER",credentialHash:hashDeviceCredential("fresh-qa-credential")});
  const fresh=await f.registry.approvePairing({accountId:portal.accountId,userCode:pending.userCode});
  assert.equal(allowed(f.authority,chat,"VAULTER",fresh.pairedAt,"process.run"),false);
  assert.equal(allowed(f.authority,chat,"RTX",f.paired.get("RTX")!,"process.run"),true);
});
