import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRelayArgs, loadOwnerAuthorityConfig } from "../src/cli-config.ts";

test("V5 relay defaults remain unchanged without explicit owner-authority config",()=>{
  const args=parseRelayArgs(["--auth-config",path.resolve("synthetic-auth-config.json"),
    "--allow-insecure-localhost"]);
  assert.equal("ownerAuthorityConfig" in args,false);
  const opted=parseRelayArgs(["--auth-config",path.resolve("synthetic-auth-config.json"),
    "--allow-insecure-localhost","--owner-authority-config",path.resolve("owner-config.json")]);
  assert.equal(opted.ownerAuthorityConfig,path.resolve("owner-config.json"));
  assert.throws(()=>parseRelayArgs(["--auth-config","auth.json","--allow-insecure-localhost",
    "--owner-authority-config"]),/requires a value/);
});

test("opt-in owner authority config accepts exact metadata only and refuses embedded credentials",async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"tp-leno-owner-cli-"));
  t.after(async()=>rm(dir,{recursive:true,force:true}));
  const p=path.join(dir,"owner.json");
  const metadata={
    owner:{accountId:"owner-a",clientId:"approved-owner-portal",principalId:"human:owner"},
    stateFile:path.join(dir,"policy.json")
  };
  await writeFile(p,JSON.stringify(metadata));
  assert.deepEqual(await loadOwnerAuthorityConfig(p),metadata);
  const invalid=[
    {...metadata,owner:{...metadata.owner,secret:"not-permitted"}},
    {...metadata,authConfig:"credential-path"},
    {...metadata,stateFile:"relative.json"},
    {...metadata,stateFile:p},
    {...metadata,owner:{...metadata.owner,clientId:"bad client id"}},
  ];
  for(const [index,item] of invalid.entries()){
    await writeFile(p,JSON.stringify(item));
    await assert.rejects(()=>loadOwnerAuthorityConfig(p),/owner authority/,"unsafe metadata "+index);
  }
});
