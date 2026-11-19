/**
 * Isolated end-to-end sign-in acceptance: synthetic TetherAuth issuer, temporary
 * loopback relay, and a disposable headless Edge profile. No production clients,
 * secrets, device registry, tasks, or OAuth grants are touched.
 * Requires Windows Microsoft Edge; run with: node scripts/portal-oidc-browser-smoke.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { RelayServer, StaticClientAuthenticator } from "../relay/dist/index.js";

const edge = process.env.EDGE_BIN ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (!fs.existsSync(edge)) throw new Error("EDGE_NOT_INSTALLED");
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tp-portal-oauth-browser-"));
const profile = path.join(dir, "edge-profile");
let browser, socket, relay, provider;
let tokenExchanges = 0;
let issuedCode = "";
let browserAuthResult = null;
let expectedChallenge = "";
const clientId = "existing-oidc-smoke-client";
const token = "synthetic-owner-credential-only";
async function reservePort() {
  const s=net.createServer();
  await new Promise((resolve,reject)=>s.once("error",reject).listen(0,"127.0.0.1",resolve));
  const p=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  return p;
}
async function closeServer(server) {
  if (server?.listening) await new Promise(resolve=>server.close(resolve));
}
try {
  let portalPort;
  provider=createServer((req,res)=>{
    const u=new URL(req.url??"/","http://127.0.0.1");
    if(u.pathname==="/auth") {
      const state=u.searchParams.get("state");
      expectedChallenge=u.searchParams.get("code_challenge")??"";
      if(!state||u.searchParams.get("code_challenge_method")!=="S256"||
        u.searchParams.get("client_id")!==clientId||
        u.searchParams.get("response_type")!=="code"||
        !u.searchParams.get("scope")?.includes("openid")) {
        res.writeHead(400).end("AUTH_REQUEST_INVALID");return;
      }
      const redirect=new URL(u.searchParams.get("redirect_uri")??"");
      issuedCode="only-one-test-authorization-code";
      redirect.searchParams.set("code",issuedCode);
      redirect.searchParams.set("state",state);
      res.writeHead(302,{location:redirect.href,"cache-control":"no-store"}).end();
      return;
    }
    if(u.pathname==="/token"&&req.method==="POST") {
      tokenExchanges++;
      const chunks=[];
      req.on("data",x=>chunks.push(x));
      req.on("end",()=>{
        const body=new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        const challenge=createHash("sha256").update(body.get("code_verifier")??"","ascii").digest("base64url");
        if(body.get("code")!==issuedCode||
            body.get("grant_type")!=="authorization_code"||
            body.get("client_id")!==clientId||
            challenge!==expectedChallenge||
            body.get("redirect_uri")!=="http://127.0.0.1:"+portalPort+"/portal/auth/callback") {
          res.writeHead(400,{"content-type":"application/json"}).end('{"error":"invalid_grant"}');return;
        }
        res.writeHead(200,{"content-type":"application/json"}).end(
          JSON.stringify({token_type:"Bearer",access_token:token,expires_in:600}));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve,reject)=>provider.once("error",reject).listen(0,"127.0.0.1",resolve));
  const issuer="http://127.0.0.1:"+provider.address().port+"/";
  portalPort=await reservePort();
  const base="http://127.0.0.1:"+portalPort;
  relay=await RelayServer.create({
    stateFile:path.join(dir,"synthetic-devices.json"),
    authenticator:new StaticClientAuthenticator([{
      token,accountId:"smoke-account",clientId,principalId:"human:smoke-account",role:"owner"
    }]),
    allowInsecureLocalhost:true,
    portalPort,
    portalReadOnly:true,
    publicOrigin:base,
    trustProxyHeaders:true,
    portalOidcLogin:{
      issuer,
      authorizationEndpoint:issuer+"auth",
      tokenEndpoint:issuer+"token",
      redirectUri:base+"/portal/auth/callback",
      clientId,
      resource:issuer+"mcp",
      scopes:["openid","tetherplane:access"],
    },
  });
  await relay.listen({host:"127.0.0.1",port:0});
  browser=spawn(edge,[
    "--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
    "--remote-debugging-port=0","--remote-debugging-address=127.0.0.1",
    "--window-size=800,900","--user-data-dir="+profile,"about:blank"
  ],{stdio:"ignore",windowsHide:true});
  const activeFile=path.join(profile,"DevToolsActivePort");
  const max=Date.now()+16000;
  while(!fs.existsSync(activeFile)&&Date.now()<max)await sleep(150);
  if(!fs.existsSync(activeFile))throw new Error("EDGE_CDP_STARTUP_FAILED");
  const cdpPort=Number((await fsp.readFile(activeFile,"utf8")).split(/\r?\n/)[0]);
  const tabs=await (await fetch("http://127.0.0.1:"+cdpPort+"/json/list")).json();
  const tab=tabs.find(t=>t.type==="page"&&t.webSocketDebuggerUrl);
  if(!tab)throw new Error("EDGE_CDP_TAB_MISSING");
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{
    socket.addEventListener("open",resolve,{once:true});
    socket.addEventListener("error",reject,{once:true});
  });
  let nextId=0;
  const calls=new Map();
  const errors=[];
  socket.addEventListener("message",event=>{
    const data=JSON.parse(event.data);
    if(data.method==="Runtime.exceptionThrown")errors.push(data.params.exceptionDetails.text);
    if(!data.id||!calls.has(data.id))return;
    const job=calls.get(data.id);calls.delete(data.id);
    if(data.error)job.reject(new Error(data.error.message));
    else job.resolve(data.result);
  });
  function command(method,params={}) {
    const id=++nextId;
    return new Promise((resolve,reject)=>{
      calls.set(id,{resolve,reject});
      socket.send(JSON.stringify({id,method,params}));
      setTimeout(()=>{if(calls.has(id)){calls.delete(id);reject(new Error("CDP_TIMEOUT_"+method))}},12000).unref();
    });
  }
  async function evaluate(expr) {
    const r=await command("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});
    return r.result?.value;
  }
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride",{width:390,height:844,mobile:true,deviceScaleFactor:1});
  await command("Page.navigate",{url:base+"/portal"});
  let signedOut;
  const before=Date.now()+8000;
  while(Date.now()<before) {
    signedOut=await evaluate("JSON.stringify({href:location.href,auth:document.body.dataset.auth,oidcMode:document.body.dataset.loginMode,linkVisible:(()=>{const e=document.getElementById('oidc-signin-link');return !!e&&getComputedStyle(e).display!=='none'})(),tokenVisible:(()=>{const e=document.getElementById('token-input');return !!e&&getComputedStyle(e).display!=='none'})()})");
    if(signedOut&&JSON.parse(signedOut).auth==="signed-out")break;
    await sleep(150);
  }
  assert.ok(signedOut);
  const parsedBefore=JSON.parse(signedOut);
  assert.equal(parsedBefore.oidcMode,"oidc");
  assert.equal(parsedBefore.linkVisible,true);
  assert.equal(parsedBefore.tokenVisible,false);
  await evaluate("document.getElementById('oidc-signin-link').click()");
  const deadline=Date.now()+12000;
  let last="";
  while(Date.now()<deadline) {
    try {
      const state=await evaluate("JSON.stringify({url:location.href,auth:document.body.dataset.auth,owner:document.getElementById('auth-state-badge')?.textContent,tokenVisible:(()=>{const e=document.getElementById('token-input');return !!e&&getComputedStyle(e).display!=='none'})(),scrollWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,cookie:document.cookie})");
      if(state){last=state;const v=JSON.parse(state);if(v.auth==="signed-in"&&v.owner?.includes("human:smoke-account")){browserAuthResult=v;break;}}
    } catch {}
    await sleep(180);
  }
  if(!browserAuthResult)throw new Error("BROWSER_OIDC_SIGNIN_FAILED: "+last.slice(0,1000));
  assert.equal(browserAuthResult.url,base+"/portal","successful callback must remove the authorization code from URL");
  assert.equal(browserAuthResult.tokenVisible,false);
  assert.equal(browserAuthResult.cookie.includes("tetherplane_portal_session"),false,"HttpOnly cookie must be invisible to page JS");
  assert.equal(browserAuthResult.viewportWidth,390);
  assert.equal(browserAuthResult.scrollWidth,390);
  assert.equal(tokenExchanges,1);
  assert.deepEqual(errors,[]);
  const sessionJson=await evaluate("(async()=>JSON.stringify(await(await fetch('/portal/api/session')).json()))()");
  assert.equal(JSON.parse(sessionJson).authenticated,true);
  const storage=await evaluate("JSON.stringify({local:localStorage.length,session:sessionStorage.length})");
  assert.deepEqual(JSON.parse(storage),{local:0,session:0});
  const shot=await command("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  await fsp.writeFile(path.join(dir,"oauth-mobile-signed-in.png"),Buffer.from(shot.data,"base64"));
  console.log("REAL_BROWSER_OIDC_PKCE_PASS");
  console.log("SIGNED_IN_IDENTITY_VERIFIED human:smoke-account");
  console.log("AUTHORIZATION_CODE_EXCHANGES "+tokenExchanges);
  console.log("MOBILE_VIEWPORT_390_NO_HORIZONTAL_OVERFLOW");
  console.log("HTTPONLY_COOKIE_UNREADABLE_AND_WEB_STORAGE_EMPTY");
  console.log("SCREENSHOT_CREATED "+path.join(dir,"oauth-mobile-signed-in.png"));
}finally{
  try{socket?.close()}catch{}
  try{browser?.kill()}catch{}
  await relay?.close();
  await closeServer(provider);
  // Keep a synthetic screenshot in the temp directory for QA while removing
  // transient browser cookie/profile data. It contains no user data.
  if(fs.existsSync(profile))await fsp.rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200});
}
