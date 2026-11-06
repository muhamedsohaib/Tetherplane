import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {copyFile, lstat, mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

export const CANARY_FILES=Object.freeze({
  "bin/tetherd-agentw.exe":"target/release/tetherd-agentw.exe",
  "router/browser-unified-rpc-host.mjs":"scripts/browser-unified-rpc-host.mjs",
  "edge/dist/background.js":"extension/browser/dist/background.js",
  "edge/dist/pair.js":"extension/browser/dist/pair.js",
  "edge/pair.html":"extension/browser/pair.html",
  "edge/manifest.json":"extension/browser/manifest.json",
});
export const REVIEW_BRANCH="refs/heads/fix/browser-combined-action-reliability-integrated-20261107";
const SCHEMA="tetherplane.browser-action.canary-review.v1";

const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
function assertCommit(ref,source){
  if(ref!==REVIEW_BRANCH)throw Error("review-only branch mismatch");
  if(!/^[0-9a-f]{40}$/.test(source))throw Error("source commit must be exact 40-character SHA");
}
async function requireRegularFile(file){
  const item=await lstat(file);
  if(!item.isFile()||item.isSymbolicLink())throw Error("not a regular source/review file");
}
async function namesInside(root,relative=""){
  const items=await readdir(path.join(root,relative),{withFileTypes:true});
  let names=[];
  for(const item of items){
    const entry=relative?relative+"/"+item.name:item.name;
    if(item.isSymbolicLink())throw Error("review package must not contain symlinks");
    if(item.isDirectory())names.push(...await namesInside(root,entry));
    else if(item.isFile()) names.push(entry);
    else throw Error("review package has unsupported file type");
  }
  return names.sort();
}
export async function verifyBundle(root,expectedSource,expectedRef=REVIEW_BRANCH){
  assertCommit(expectedRef,expectedSource);
  const pathToInfo=path.join(root,"evidence.json");
  await requireRegularFile(pathToInfo);
  const info=JSON.parse(await readFile(pathToInfo,"utf8"));
  if(info.schema!==SCHEMA||info.source_commit!==expectedSource ||
      info.source_ref!==expectedRef||info.release!=="NO_GO"||
      info.authenticode!=="NOT_ESTABLISHED" ||
      info.installed!==false || info.grants_changed!==false ||
      info.auth_changed!==false)
    throw Error("review package metadata or safety verdict mismatch");
  const keys=Object.keys(CANARY_FILES).sort();
  const actual=await namesInside(root);
  if(JSON.stringify(actual)!==JSON.stringify([...keys,"evidence.json"].sort()))
    throw Error("review package has missing or unexpected files");
  if(!info.files||Object.keys(info.files).length!==keys.length ||
     Object.keys(info.files).some(k=>!keys.includes(k)))
    throw Error("review inventory file list differs");
  for(const key of keys){
    const file=path.join(root,...key.split("/"));
    await requireRegularFile(file);
    const data=await readFile(file);
    if(info.files[key]?.sha256!==sha256(data)||
       info.files[key]?.bytes!==data.length)
      throw Error("review package digest mismatch: "+key);
  }
  return {verdict:"HASHES_MATCH_UNINSTALLED_NO_GO",source_commit:expectedSource,files_verified:keys.length};
}
export async function stageBundle(sourceRoot,destination,source,ref=REVIEW_BRANCH){
  assertCommit(ref,source);
  await mkdir(destination); // Refuse an existing candidate; never overwrite it.
  const evidence={schema:SCHEMA,source_commit:source,source_ref:ref,
    release:"NO_GO",authenticode:"NOT_ESTABLISHED",installed:false,
    grants_changed:false,auth_changed:false,
    files:{}};
  for(const [key,relative] of Object.entries(CANARY_FILES)){
    const input=path.join(sourceRoot,...relative.split("/"));
    const target=path.join(destination,...key.split("/"));
    await requireRegularFile(input);
    await mkdir(path.dirname(target),{recursive:true});
    await copyFile(input,target);
    const bytes=await readFile(target);
    evidence.files[key]={sha256:sha256(bytes),bytes:bytes.length};
  }
  await writeFile(path.join(destination,"evidence.json"),JSON.stringify(evidence,null,2)+"\n","utf8");
  return verifyBundle(destination,source,ref);
}
const direct=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  const [operation,sourceRoot,destination,sha,ref]=process.argv.slice(2);
  try{
    if(operation==="--stage" && sourceRoot && destination && sha && ref){
      const g=spawnSync("git",["-C",sourceRoot,"rev-parse","HEAD"],{encoding:"utf8",timeout:5000});
      if(g.status!==0||g.stdout.trim()!==sha)throw Error("checkout HEAD does not match claimed source commit");
      console.log(JSON.stringify(await stageBundle(sourceRoot,destination,sha,ref)));
    }else if(operation==="--verify" && sourceRoot && destination && !ref){
      // Syntax: --verify EXTRACTED_ROOT EXACT_SOURCE_SHA SOURCE_REF
      console.log(JSON.stringify(await verifyBundle(sourceRoot,destination,sha)));
    }else throw Error("usage: --stage SOURCE_ROOT EMPTY_DESTINATION SHA REF | --verify STAGED_ROOT SHA REF");
  }catch(error){
    console.error("BROWSER_ACTION_CANARY_NO_GO: "+String(error?.message??error).slice(0,200));
    process.exitCode=1;
  }
}
