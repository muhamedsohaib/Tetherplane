import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, unlink, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

assert.equal(process.platform, "win32", "Requires isolated Windows native test");
assert.equal(process.argv.length, 3, "Single staged package path required");
const stage = resolve(process.argv[2]);
const launcher = join(stage, "bin", "tetherplane-browserw.exe");
const temp = await mkdtemp(join(tmpdir(), "tp-pr129-native-background-"));
const state = join(temp, "state");
await mkdir(state);
const tokenA = randomBytes(32).toString("hex");
const tokenB = randomBytes(32).toString("hex");
const marker = join(state, "browser-background.optin");
const argv = ["--browser-state-dir", state, "--require-background-optin"];
const ports = [];
async function getPort() {
  const server = createServer();
  await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const port = server.address().port;
  await new Promise(yes => server.close(yes));
  return port;
}
while (ports.length < 3) { const port = await getPort(); if (!ports.includes(port)) ports.push(port); }
const env = { ...process.env, LOCALAPPDATA: temp, TETHERPLANE_EXTENSION_WS_PORT: String(ports[0]),
  TETHERPLANE_EXTENSION_PAIRING_PORT: String(ports[1]), TETHERPLANE_AUTH_BROWSER_RPC_PORT: String(ports[2]) };
function run() { return spawn(launcher, argv, { cwd: stage, env, windowsHide: true, stdio: "ignore" }); }
async function exitWithin(child, ms) {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise(resolve => { child.once("exit", code => resolve(code ?? 2)); child.once("error", () => resolve("ERROR")); }),
    sleep(ms).then(() => "TIMEOUT")
  ]);
}
async function listening(port) {
  return new Promise(resolve => { const s=connect({host:"127.0.0.1",port});
    const done=x=>{s.destroy();resolve(x)}; s.setTimeout(450,()=>done(false));
    s.once("connect",()=>done(true));s.once("error",()=>done(false)); });
}
async function until(fn, ms, message) {
  const end=Date.now()+ms; while(Date.now()<end) { if(await fn())return; await sleep(125); } throw Error(message);
}
function ownedNode(pid) {
  const command="$p=@(Get-CimInstance Win32_Process -Filter \"ParentProcessId="+pid+" AND Name='node.exe'\" -ErrorAction SilentlyContinue); @($p|ForEach-Object {$_.ProcessId}) -join ','";
  const out=execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],
    {windowsHide:true,encoding:"utf8",timeout:8000}).trim();
  return out.split(",").filter(Boolean).map(Number);
}
let owner=null, nodePid=null;
try {
  await writeFile(join(state,"browser-bridge.token"), tokenA+"\n");
  await writeFile(join(state,"browser-extension-launch.token"), tokenB+"\n");
  await writeFile(join(state,"browser-extension.id"), "abcdefghijklmnopabcdefghijklmnop\n");
  let attempt=run();
  const missing=await exitWithin(attempt,6000);
  if(missing==="TIMEOUT")attempt.kill();
  assert.equal(typeof missing,"number");assert.notEqual(missing,0);
  assert.equal(await listening(ports[0]),false);
  console.log("RTX_BG_OWNER_MARKER_REQUIRED_PASS");
  await writeFile(marker,"tampered\n");
  attempt=run();const tampered=await exitWithin(attempt,6000);
  if(tampered==="TIMEOUT")attempt.kill();
  assert.equal(typeof tampered,"number");assert.notEqual(tampered,0);
  console.log("RTX_BG_TAMPERED_MARKER_DENIED_PASS");
  await writeFile(marker,"owner-approved-browser-background-v1\n");
  owner=run();
  await until(async()=>owner.exitCode===null && (await listening(ports[0])) && (await listening(ports[1])),
    18000,"owner-approved native browser host failed to start");
  assert.equal(await listening(ports[2]),false);
  console.log("RTX_BG_EXPLICIT_OWNER_START_LOOPBACK_PASS");
  const second=run(); const duplicate=await exitWithin(second,6500);
  if(duplicate==="TIMEOUT")second.kill();
  assert.equal(typeof duplicate,"number");assert.notEqual(duplicate,0);
  assert.equal(await listening(ports[0]),true);
  console.log("RTX_BG_DUPLICATE_NATIVE_HOST_DENIED_PASS");
  const owned=ownedNode(owner.pid); assert.equal(owned.length,1);
  nodePid=owned[0]; assert.ok(Number.isSafeInteger(nodePid)&&nodePid>0);
  await unlink(marker);
  process.kill(nodePid);
  const withdrawn=await exitWithin(owner,20000);
  assert.equal(typeof withdrawn,"number");assert.notEqual(withdrawn,0);
  await until(async()=> !(await listening(ports[0])) && !(await listening(ports[1])),
    8500,"revoked owner browser left loopback service");
  console.log("RTX_BG_WITHDRAWAL_BLOCKS_RELAUNCH_NO_ORPHAN_PASS");
  for(const name of ["browser-host.stdout.log","browser-host.stderr.log"]){
    const log=await readFile(join(state,name),"utf8");
    assert.ok(!log.includes(tokenA)&&!log.includes(tokenB),"synthetic token leaked into logs");
  }
  console.log("RTX_BG_CREDENTIAL_LOG_REDACTION_PASS");
} finally {
  if(owner?.exitCode===null) owner.kill();
  if(nodePid>0) {
    try { execFileSync("taskkill.exe",["/PID",String(nodePid),"/F"],{windowsHide:true,stdio:"ignore",timeout:5000}); } catch {}
  }
  await rm(temp,{force:true,recursive:true,maxRetries:10,retryDelay:120});
}
