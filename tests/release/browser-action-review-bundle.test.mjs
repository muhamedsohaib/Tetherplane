import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import {CANARY_FILES,REVIEW_BRANCH,stageBundle,verifyBundle} from "../../scripts/release/browser-action-review-bundle.mjs";

const SHA="a".repeat(40);
async function fixture(t){
  const parent=await mkdtemp(path.join(os.tmpdir(),"tp-action-review-"));
  t.after(()=>rm(parent,{recursive:true,force:true,maxRetries:4,retryDelay:150}));
  const src=path.join(parent,"source"),dest=path.join(parent,"review");
  await mkdir(src);
  for(const [name,source] of Object.entries(CANARY_FILES)){
    const p=path.join(src,...source.split("/"));
    await mkdir(path.dirname(p),{recursive:true});
    await writeFile(p,"SYNTHETIC ONLY "+name,"utf8");
  }
  return {src,dest};
}
test("stages only an explicit, hash-verified, uninstalled review inventory",async t=>{
  const {src,dest}=await fixture(t);
  const staged=await stageBundle(src,dest,SHA,REVIEW_BRANCH);
  assert.equal(staged.verdict,"HASHES_MATCH_UNINSTALLED_NO_GO");
  assert.equal(staged.files_verified,6);
  const cli=spawnSync(process.execPath,[
    path.join(process.cwd(),"scripts","release","browser-action-review-bundle.mjs"),
    "--verify",dest,SHA,REVIEW_BRANCH,
  ],{encoding:"utf8",timeout:10000});
  assert.equal(cli.status,0,cli.stderr);
  assert.match(cli.stdout,/HASHES_MATCH_UNINSTALLED_NO_GO/);
  const evidence=JSON.parse(await readFile(path.join(dest,"evidence.json"),"utf8"));
  assert.equal(evidence.release,"NO_GO");
  assert.equal(evidence.installed,false);
  assert.equal(evidence.grants_changed,false);
  assert.equal(evidence.auth_changed,false);
  assert.equal(evidence.authenticode,"NOT_ESTABLISHED");
  assert.deepEqual(Object.keys(evidence.files).sort(),Object.keys(CANARY_FILES).sort());
  await assert.rejects(()=>stageBundle(src,dest,SHA,REVIEW_BRANCH));
});
test("rejects tampered binaries, unexpected files, wrong source and branch",async t=>{
  const {src,dest}=await fixture(t);
  await stageBundle(src,dest,SHA,REVIEW_BRANCH);
  await assert.rejects(()=>verifyBundle(dest,"b".repeat(40),REVIEW_BRANCH),/metadata/);
  await assert.rejects(()=>verifyBundle(dest,SHA,"refs/heads/main"),/branch mismatch/);
  await writeFile(path.join(dest,"edge","dist","background.js"),"tampered", "utf8");
  await assert.rejects(()=>verifyBundle(dest,SHA,REVIEW_BRANCH),/digest mismatch/);
});
test("refuses unexpected archive contents and missing reviewed components",async t=>{
  const {src,dest}=await fixture(t);
  await stageBundle(src,dest,SHA,REVIEW_BRANCH);
  await writeFile(path.join(dest,"surprise.txt"),"unexpected","utf8");
  await assert.rejects(()=>verifyBundle(dest,SHA,REVIEW_BRANCH),/missing or unexpected/);
});
