// Portable developer-beta launcher. No installation, task changes, or credential reads.
import {createHash} from "node:crypto";
import {readFile,lstat} from "node:fs/promises";
import {execFileSync,spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const files=[
 "bin/tetherd-agentw.exe","bin/tetherplane-setupw.exe","bin/tetherplane-browserw.exe",
 "runtime/node.exe","runtime/LICENSE.node.txt","app/preflight.mjs",
 "app/runtime-app.mjs","app/state-security.mjs","app/setup.html",
 "app/setup-client.js","app/setup.css","app/assets/brand-32.png",
 "app/assets/brand-128.png","START HERE.cmd",
 "browser/package.json","browser/dist/index.js","browser/host.mjs",
 "browser/extension/manifest.json","browser/extension/pair.html",
 "browser/extension/dist/background.js","browser/extension/dist/pair.js",
 "browser/extension/icons/brand-16.png","browser/extension/icons/brand-32.png",
 "browser/extension/icons/brand-48.png","browser/extension/icons/brand-128.png"
];
const extraRoots=[
 "browser/node_modules/","browser/dist/","browser/extension/dist/",
 "browser/extension/icons/"
];

function permittedRelativeFile(file){
 if(typeof file!=="string"||file.startsWith("/")||file.includes("\\")||
   file.split("/").some(part=>!part||part==="."||part===".."||/[\x00-\x1f:]/.test(part)))return false;
 return files.includes(file)||extraRoots.some(prefix=>file.startsWith(prefix));
}
async function regularFileBelow(rootDir,relative){
 const components=relative.split("/");
 let cursor=rootDir;
 for(let i=0;i<components.length;i++){
  cursor=path.join(cursor,components[i]);
  const entry=await lstat(cursor);
  if(entry.isSymbolicLink())throw Error("Package has a link: "+relative);
  if(i<components.length-1&&!entry.isDirectory())throw Error("Package parent is not a directory: "+relative);
  if(i===components.length-1&&!entry.isFile())throw Error("Package file is not regular: "+relative);
 }
 return cursor;
}

export async function verifyCandidate(dir=root){
 const packageRoot=path.resolve(dir);
 const meta=JSON.parse(await readFile(path.join(packageRoot,"developer-beta.json"),"utf8"));
 if(meta.schema!=="tetherplane.developer-beta.package.v1")throw Error("Unexpected developer-beta metadata");
 if(!/^[a-f0-9]{40}$/.test(meta.source_commit))throw Error("Invalid source revision");
 if(meta.file_hashes===null || typeof meta.file_hashes!=="object" ||
   Array.isArray(meta.file_hashes))throw Error("Invalid package hash manifest");
 const keys=Object.keys(meta.file_hashes);
 if(meta.browser_payload_included!==true||
   meta.browser_activation!=="owner_explicit_separate"||
   meta.tetherplane_product_signed!==false||
   meta.explicit_owner_pairing_required!==true||
   meta.no_automatic_startup_task!==true||
   meta.no_authentication_secrets_in_package!==true)
   throw Error("Browser owner-approval or package trust metadata changed");
 if(keys.length<files.length||keys.length>5000||
   keys.some(x=>!permittedRelativeFile(x))||
   new Set(keys.map(x=>x.toLowerCase())).size!==keys.length||
   files.some(x=>!keys.includes(x)))throw Error("Package file manifest changed");
 for(const item of keys){
  if(!/^[a-f0-9]{64}$/.test(meta.file_hashes[item]))
   throw Error("Package digest entry invalid: "+item);
  const filename=await regularFileBelow(packageRoot,item);
  const actual=createHash("sha256").update(await readFile(filename)).digest("hex");
  if(actual!==meta.file_hashes[item])throw Error("Package integrity check failed: "+item);
 }
 return {source_commit:meta.source_commit,files_verified:keys.length,
   relay_configured:Boolean(meta.public_relay_url),browser_payload_included:true,
   browser_activation:"owner_explicit_separate",
   signature_note:"Tetherplane developer beta binaries are not product-signed"};
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
