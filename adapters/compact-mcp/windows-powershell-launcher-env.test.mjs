import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import test from "node:test";

const here=dirname(fileURLToPath(import.meta.url));
const canonical=resolve(here,"..","..","packaging","windows","tetherplane-mcp.ps1");
const fixtureServer=resolve(here,"windows-mcp-test-server.mjs");
const names=["batch","browser","desktop","device","files","process"];
const historicalLauncher = String.raw`param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tetherd = Join-Path $root "bin\tetherd.exe"
$server = Join-Path $root "adapters\compact-mcp\dist\stdio-server.js"
$config = Join-Path $root "config\install.json"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required to run the Compact MCP edge"
}
if (-not (Test-Path -LiteralPath $tetherd -PathType Leaf)) {
    throw "installed tetherd is missing: $tetherd"
}
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
    throw "installed Compact MCP server is missing: $server"
}

$forward = @()
if ((Test-Path -LiteralPath $config -PathType Leaf) -and ($RemainingArgs -notcontains "--state-dir")) {
    $install = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
    if ($install.state_dir) {
        $forward += @("--state-dir", [string]$install.state_dir)
    }
}
$forward += $RemainingArgs

& node $server --tetherd $tetherd @forward
exit $LASTEXITCODE
`;

async function bounded(promise,ms){
 let timer;
 try{return await Promise.race([
  promise, new Promise((_,reject)=>timer=setTimeout(()=>reject(Error("MCP SDK handshake timeout")),ms)),
 ]);}finally{clearTimeout(timer);}
}

async function connectViaLauncher(launcher,allow,state){
 const transport=new StdioClientTransport({
  command:"powershell.exe",
  args:["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",launcher,"--allow",allow,"--state-dir",state],
  cwd:dirname(launcher),
  stderr:"pipe",
 });
 let stderr="";
 transport.stderr?.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-2048);});
 const client=new Client({name:"tetherplane-windows-stdio-regression",version:"0.1.0"},{capabilities:{}});
 let worked=false;
 try{
  await bounded(client.connect(transport),7000);
  const tools=await bounded(client.listTools(),4000);
  assert.deepEqual(tools.tools.map(x=>x.name).sort(),names);
  worked=true;
  return {worked,error:null};
 }catch(error){
  return{worked,error:error instanceof Error?error.message:String(error),stderr};
 }finally{
  await bounded(client.close(),5000).catch(()=>undefined);
 }
}

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),"tetherplane-real-powershell-launcher-"));
 t.after(async()=>{
  // The temporary package contains no production identity or state.
  await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:250});
 });
 const make=async (subdir,source)=>{
  const prefix=join(root,"installed folder with spaces",subdir);
  const launch=join(prefix,"launch","tetherplane-mcp.ps1");
  const serverDir=join(prefix,"adapters","compact-mcp","dist");
  const exeDir=join(prefix,"bin");
  const allow=join(prefix,"allowed folder with spaces");
  const state=join(prefix,"state folder with spaces");
  for(const dir of [dirname(launch),serverDir,exeDir,allow,state])await mkdir(dir,{recursive:true});
  await writeFile(launch,source);
  await writeFile(join(exeDir,"tetherd.exe"),"SYNTHETIC_NONEXECUTABLE_PLACEHOLDER");
  const importUrl=pathToFileURL(fixtureServer).href;
  await writeFile(join(serverDir,"stdio-server.js"),'import("'+importUrl+'").catch(e => {console.error(e);process.exitCode=1;});\n');
  return {launch,allow,state};
 };
 return {make};
}

test("diagnostic only: isolate SDK fixture from PowerShell raw stdio relay",{
 skip:process.platform!=="win32",
 timeout:25_000
},async t=>{
 const {make}=await fixture(t);
 const data=await make("diag",await readFile(canonical,"utf8"));
 const directTransport=new StdioClientTransport({
   command:process.execPath,
   args:[fixtureServer,"--tetherd",resolve(dirname(data.launch),"..","bin","tetherd.exe"),
     "--allow",data.allow,"--state-dir",data.state],
   stderr:"pipe"
 });
 const directClient=new Client({name:"direct-sdk-negative-control",version:"1"},{capabilities:{}});
 let sdkDirect=false;
 try{
   await bounded(directClient.connect(directTransport),5000);
   const listed=await bounded(directClient.listTools(),3000);
   sdkDirect=listed.tools.length===6;
 }finally{await bounded(directClient.close(),4000).catch(()=>undefined);}
 assert.equal(sdkDirect,true,"direct Node fixture must pass before PowerShell is blamed");
 const child=spawn("powershell.exe",[
  "-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass",
  "-File",data.launch,"--allow",data.allow,"--state-dir",data.state
 ],{cwd:dirname(data.launch),env:getDefaultEnvironment(),windowsHide:true,stdio:["pipe","pipe","pipe"]});
 let stdout="",stderr="",childError=null,childExit=null;
 child.stdout.on("data",buf=>{stdout=(stdout+buf.toString("utf8")).slice(-1500);});
 child.stderr.on("data",buf=>{stderr=(stderr+buf.toString("utf8")).slice(-1800);});
 child.on("error",e=>{childError=e.code||e.message;});
 child.on("exit",code=>{childExit=code;});
 const frame={jsonrpc:"2.0",id:1,method:"initialize",params:{
   protocolVersion:"2025-06-18",capabilities:{},
   clientInfo:{name:"stdio-diagnostic-only",version:"1"}
 }};
 child.stdin.write(JSON.stringify(frame)+"\n");
 await new Promise(resolveWait=>setTimeout(resolveWait,2600));
 console.log("SYNTHETIC_WINDOWS_STDIO_WIRE "+JSON.stringify({
   directSDK:sdkDirect, responseSeen:stdout.includes('"result"'),
   childExited:childExit!==null,childExit,childError,
   stdout:stdout.slice(-750),stderr:stderr.slice(-1300),
   inheritedPath:Boolean(getDefaultEnvironment().PATH),
   inheritedPathext:Boolean(getDefaultEnvironment().PATHEXT)
 }));
 child.stdin.end();
 await Promise.race([
   new Promise(resolveClose=>child.once("exit",resolveClose)),
   new Promise(resolveWait=>setTimeout(resolveWait,1200))
 ]);
 if(child.exitCode===null)child.kill();
});
test("stock MCP SDK environment excludes PATHEXT: a regression check for Windows native execution",{
 skip:process.platform!=="win32"
},async()=>{
 const env=getDefaultEnvironment();
 assert.equal(Object.hasOwn(env,"PATHEXT"),false);
 const actual=await readFile(canonical,"utf8");
 assert.doesNotMatch(actual,/\$env:PATHEXT\s*=/, "the launcher must not modify the environment");
});

test("actual installed PowerShell launcher transports six MCP tools with the restricted SDK environment",{
 skip:process.platform!=="win32"
},async t=>{
 const {make}=await fixture(t);
 const fixedSource=await readFile(canonical,"utf8");
 const testPackage=await make("fixed",fixedSource);
 const observed=await connectViaLauncher(testPackage.launch,testPackage.allow,testPackage.state);
 assert.equal(observed.worked,true,JSON.stringify(observed));
 const slashEnding=await connectViaLauncher(testPackage.launch,testPackage.allow+"\\",testPackage.state+"\\");
 assert.equal(slashEnding.worked,true,"trailing-backslash quoting: "+JSON.stringify(slashEnding));
});

test("historical launcher fails under the restricted MCP SDK environment",{
 skip:process.platform!=="win32"
},async t=>{
 const {make}=await fixture(t);
 const testPackage=await make("historical",historicalLauncher);
 const observed=await connectViaLauncher(testPackage.launch,testPackage.allow,testPackage.state);
 assert.equal(observed.worked,false,"negative control unexpectedly succeeded");
 assert.match(String(observed.error),/closed|timeout|disconnect|failed/i);
});
