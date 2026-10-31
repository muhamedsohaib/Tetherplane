import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayServer } from "../src/server.ts";
import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";

const owner={accountId:"owner-a",clientId:"verified-owner-editor",principalId:"human:owner"};
const authenticator=new StaticClientAuthenticator([{
  ...owner,token:"test-existing-owner-token",
}]);
const grant=(deviceId:string,clientId:string)=>({
  deviceId,pairedAt:"2026-10-26T10:00:00Z",clientId,
  principalId:"human:owner",level:"full"
});

test("V5 Leno-only opt-in refuses global, foreign-device and multi-client owner policy at startup",async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"tp-leno-startup-fence-"));
  t.after(async()=>rm(dir,{recursive:true,force:true}));
  const cases=[
    {enabled:true,grants:[],enforcedDevices:[]},
    {enabled:false,grants:[],enforcedDevices:["RTX"]},
    {enabled:false,grants:[grant("RTX","client-a")],enforcedDevices:[]},
    {enabled:false,grants:[grant("Leno","client-a"),grant("Leno","client-b")],enforcedDevices:[]},
  ];
  for(let index=0;index<cases.length;index++){
    const stateFile=path.join(dir,"case-"+index+".json");
    await writeFile(stateFile,JSON.stringify({version:1,revision:0,...cases[index]})+"\n");
    await assert.rejects(
      () => RelayServer.create({
        authenticator,allowInsecureLocalhost:true,ownerAuthority:{owner,stateFile},
      }),
      /Leno-only owner policy refuses global or unrelated device grants/,
      "Case "+index+" must fail closed before any port opens",
    );
  }
});
