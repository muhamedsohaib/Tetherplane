// Nonrelease Windows synthetic setup acceptance: no MSIX install, identity,
// browser profile, OAuth, network relay or production task is involved.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { copyFile, readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
assert.equal(process.platform, "win32", "Windows only");
assert.ok(process.argv[2], "exact compiled Store launcher required");

const tmp = await mkdtemp(join(tmpdir(), "tp-store-setupw-"));
const bin = join(tmp, "bin"), runtime = join(tmp, "runtime"), app = join(tmp, "app");
const exe = join(bin, "tetherplane-setupw.exe");
let processHandle;
let childPid;
const ps = cmd => execFileSync("powershell.exe", ["-NoProfile","-NonInteractive","-Command",cmd], {
  encoding: "utf8", windowsHide: true, timeout: 7000,
}).trim();
const windows = pid => ps("$p=Get-Process -Id "+pid+" -ErrorAction Stop; if($p.MainWindowHandle -eq [IntPtr]::Zero){'NONE'}else{'VISIBLE'}") !== "NONE";
const children = pid => ps('$p=@(Get-CimInstance Win32_Process -Filter "ParentProcessId='+pid+' AND Name=\'node.exe\'" -ErrorAction SilentlyContinue); @($p|ForEach-Object {$_.ProcessId}) -join ","')
  .split(",").filter(Boolean).map(Number);
const start = (args=[], env=process.env) => spawn(exe, args, { cwd: tmp, env, windowsHide: false, stdio: "ignore" });
async function termination(child, timeout=5500) {
  return await Promise.race([new Promise(r=>child.once("exit",r)), sleep(timeout).then(()=> "TIMEOUT")]);
}
async function freePort() {
  const server=createServer();
  await new Promise((ok,fail)=>{server.once("error",fail);server.listen(0,"127.0.0.1",ok)});
  const port=server.address().port; await new Promise(ok=>server.close(ok));return port;
}
async function listening(port) {
  return await new Promise(done=>{const c=connect({host:"127.0.0.1",port});
    const finish=v=>{c.destroy();done(v)};c.setTimeout(500,()=>finish(false));
    c.once("connect",()=>finish(true));c.once("error",()=>finish(false));});
}
async function until(fn,ms,message) {
  const end=Date.now()+ms;
  while(Date.now()<end){if(await fn())return;await sleep(125)}
  throw Error(message);
}
const stub=[
'import { createServer } from "node:net";',
'const p=Number(process.env.TETHERPLANE_STORE_LAUNCHER_PID);',
'if(!Number.isSafeInteger(p)||p<=0||p!==process.ppid)process.exit(21);',
'const port=Number(process.env.TP_SYNTHETIC_SETUP_PORT);',
'const server=createServer(s=>s.end());server.listen(port,"127.0.0.1");',
'const timer=setInterval(()=>{try{process.kill(p,0)}catch{server.close(()=>process.exit(0))}},500);timer.unref();',
].join("\n")+"\n";
try {
  await mkdir(bin);await mkdir(runtime);await mkdir(app);
  await copyFile(resolve(process.argv[2]), exe);
  const raw=await readFile(exe), off=raw.readUInt32LE(0x3c);
  assert.equal(raw.readUInt16LE(off+24+68),2,"Store entrypoint is not a GUI PE");
  let denied=start();
  assert.notEqual(await termination(denied),"TIMEOUT");
  assert.notEqual(denied.exitCode,0,"incomplete Store package must be denied");
  denied=start(["--unexpected"]);
  assert.notEqual(await termination(denied),"TIMEOUT");
  assert.notEqual(denied.exitCode,0,"unreviewed arguments must be denied");
  await copyFile(process.execPath,join(runtime,"node.exe"));
  await writeFile(join(app,"runtime-app.mjs"),stub,"utf8");
  const port=await freePort();
  processHandle=start([], {...process.env,LOCALAPPDATA:tmp,TP_SYNTHETIC_SETUP_PORT:String(port)});
  await until(async()=>{
    if(processHandle.exitCode!==null)throw Error("Store setup launcher exited");
    return await listening(port);
  },14000,"GUI-subsystem wrapper failed to start owned CUI Node");
  const nodePids=children(processHandle.pid);
  assert.equal(nodePids.length,1,"only one owned Node setup process is allowed");
  childPid=nodePids[0];
  assert.equal(windows(processHandle.pid),false,"Store setup launcher displayed a terminal");
  assert.equal(windows(childPid),false,"Node setup child displayed a terminal");
  processHandle.kill();
  await until(async()=>!(await listening(port)),8500,"orphan setup retained localhost");
  console.log("STORE_SETUPW_FAIL_CLOSED_MISSING_PAYLOAD_PASS");
  console.log("STORE_SETUPW_WINDOWLESS_GUI_AND_NODE_PASS");
  console.log("STORE_SETUPW_PARENT_EXIT_NO_ORPHAN_PASS");
} finally {
  if(processHandle?.exitCode===null)processHandle.kill();
  if(childPid){try{execFileSync("taskkill.exe",["/PID",String(childPid),"/F"],{windowsHide:true,timeout:5000,stdio:"ignore"})}catch{}}
  await rm(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:120});
}
