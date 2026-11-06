// Portable developer-beta launcher. No installation, task changes, or credential reads.
import {createHash} from "node:crypto";
import {readFile,lstat} from "node:fs/promises";
import {execFileSync,spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const files=[
 "bin/tetherd-agentw.exe","bin/tetherplane-setupw.exe","runtime/node.exe",
 "runtime/LICENSE.node.txt","app/preflight.mjs","app/runtime-app.mjs","app/state-security.mjs",
 "app/setup.html","app/setup-client.js","app/setup.css",
 "app/assets/brand-32.png","app/assets/brand-128.png","START HERE.cmd"
];

export async function verifyCandidate(dir=root){
 const packageRoot=path.resolve(dir);
 const meta=JSON.parse(await readFile(path.join(packageRoot,"developer-beta.json"),"utf8"));
 if(meta.schema!=="tetherplane.developer-beta.package.v1")throw Error("Unexpected developer-beta metadata");
 if(!/^[a-f0-9]{40}$/.test(meta.source_commit))throw Error("Invalid source revision");
 if(meta.file_hashes===null || typeof meta.file_hashes!=="object" ||
   Array.isArray(meta.file_hashes))throw Error("Invalid package hash manifest");
 const keys=Object.keys(meta.file_hashes);
 if(keys.length!==files.length || keys.some(x=>!files.includes(x)) ||
   files.some(x=>!keys.includes(x)))throw Error("Package file manifest changed");
 for(const item of files){
  const filename=path.join(packageRoot,...item.split("/"));
  const stats=await lstat(filename);
  if(!stats.isFile() || stats.isSymbolicLink())throw Error("Package file is not a regular file: "+item);
  const actual=createHash("sha256").update(await readFile(filename)).digest("hex");
  if(actual!==meta.file_hashes[item])throw Error("Package integrity check failed: "+item);
 }
 return {source_commit:meta.source_commit,files_verified:files.length,relay_configured:Boolean(meta.public_relay_url),signature_note:"Tetherplane developer beta binaries are not product-signed"};
}

export function hasExistingAgent(){
 if(process.platform!=="win32")throw Error("Portable setup requires Windows");
 for(const image of ["tetherd-agentw.exe","tetherd.exe"]){
  let output;
  try{
   output=execFileSync("tasklist.exe",["/NH","/FO","CSV","/FI","IMAGENAME eq "+image],
     {encoding:"utf8",windowsHide:true,timeout:5000,maxBuffer:32768});
  }catch{throw Error("Cannot verify existing agents; refusing parallel installation");}
  if(output.toLowerCase().includes('"'+image.toLowerCase()+'"'))return true;
 }
 return false;
}

const cli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(cli){
 try {
  if(!["--check","--start"].includes(process.argv[2]) || process.argv.length!==3)throw Error("Use START HERE.cmd");
  if(process.platform!=="win32"||process.arch!=="x64")throw Error("This beta requires Windows x64");
  if(path.normalize(process.execPath).toLowerCase()!==
     path.normalize(path.join(root,"runtime","node.exe")).toLowerCase())
    throw Error("Run the included Node executable; system runtime not used");
  if(Number(process.versions.node.split(".")[0])<22)throw Error("Node 22+ required");
  const candidate=await verifyCandidate();
  if(process.argv[2]==="--check"){
   console.log("TETHERPLANE_BETA_PACKAGE_CHECK_PASS "+candidate.source_commit);
  }else{
   if(hasExistingAgent())throw Error("Another Tetherplane agent is running on this computer. Existing identity preserved; do not create a second device.");
   const exe=path.join(root,"bin","tetherplane-setupw.exe");
   const child=await new Promise((resolve,reject)=>{
     const started=spawn(exe,[],{cwd:root,windowsHide:true,detached:true,stdio:"ignore"});
     started.once("spawn",()=>resolve(started));
     started.once("error",reject);
   });
   child.unref();
   console.log("Opening owner-approved Tetherplane setup; no connection claimed yet.");
  }
 }catch(error){
  console.error("SETUP_BLOCKED: "+String(error?.message??error).slice(0,200));
  process.exitCode=1;
 }
}
