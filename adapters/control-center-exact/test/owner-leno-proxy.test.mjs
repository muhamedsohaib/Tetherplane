import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OwnerLenoPortalProxy } from "../owner-leno-proxy.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function setup(t,{editor=true,authority=true}={}) {
  const history=[];
  const portal={
    origin:null,
    authority:authority?{
      registry:{
        adminSubjects:new Set(editor?["subject-owner"]:[]),
        async checkedActor(token,deviceId) {
          if(token!=="simulated-session-bearer"||deviceId!=="Leno")
            throw Object.assign(new Error("invalid owner identity"),{status:403,code:"owner_approval_required"});
          return {sub:"subject-owner"};
        }
      },
      limitMutations(){history.push({kind:"rate_limit"})},
    }:null,
    session(req) {
      if(req.headers.cookie!=="allowed-session")
        throw Object.assign(new Error("Session invalid"),{status:401,code:"authentication_required"});
      return {session:{token:"simulated-session-bearer",csrf:"simulated-csrf"}};
    },
    requireCsrf(req,session){
      if(req.headers["x-csrf-token"]!==session.csrf)
        throw Object.assign(new Error("CSRF blocked"),{status:403,code:"csrf_denied"});
    },
    async relay(url,token,method,body) {
      assert.equal(token,"simulated-session-bearer");
      history.push({kind:"relay",url,method,body});
      return url==="/owner/leno"
        ? {enabled:false,revision:0,grants:[],clients:[],enforcedDevices:[]}
        : {revision:1,deviceId:"Leno",enabled:body?.enabled??false};
    }
  };
  const proxy=new OwnerLenoPortalProxy(portal);
  const srv=createServer((req,res)=>void proxy.handle(req,res));
  await new Promise(r=>srv.listen(0,"127.0.0.1",r));
  const origin="http://127.0.0.1:"+srv.address().port;
  portal.origin=origin;
  t.after(async()=>{await new Promise((r,err)=>srv.close(e=>e?err(e):r()));});
  async function request(route,options={}) {
    const {method="GET",body,csrf="simulated-csrf",cookie="allowed-session",originHeader=true}=options;
    const resp=await fetch(origin+route,{method,headers:{
      ...(cookie?{cookie}:{}),
      ...(originHeader&&method==="POST"?{origin}:{}),
      ...(method==="POST"&&csrf?{"x-csrf-token":csrf}:{}),
      ...(body?{"content-type":"application/json"}:{})
    },...(body?{body:JSON.stringify(body)}:{})});
    return {status:resp.status,data:await resp.json()};
  }
  return {request,history};
}
const grant={
  revision:0,clientId:"observed-client",principalId:"human:owner",confirmation:"TRUST Leno"
};

test("V5 owner session and enrolled editor are both required",async t=>{
  const f=await setup(t);
  assert.equal((await f.request("/api/owner-leno",{cookie:null})).status,401);
  assert.equal((await f.request("/api/owner-leno")).status,200);
  assert.deepEqual(f.history.filter(x=>x.kind==="relay").map(x=>x.url),["/owner/leno"]);
  const g=await setup(t,{editor:false});
  assert.equal((await g.request("/api/owner-leno")).status,403);
  assert.equal(g.history.filter(x=>x.kind==="relay").length,0);
  const unavailable=await setup(t,{authority:false});
  assert.equal((await unavailable.request("/api/owner-leno")).status,503);
});

test("Leno mutation is same-origin, CSRF-bound and exact-confirmation",async t=>{
  const f=await setup(t);
  assert.equal((await f.request("/api/owner-leno/grant",{method:"POST",body:grant,csrf:null})).status,403);
  assert.equal((await f.request("/api/owner-leno/grant",{method:"POST",body:grant,originHeader:false})).status,403);
  assert.equal((await f.request("/api/owner-leno/grant",{method:"POST",body:{...grant,confirmation:"YES"}})).status,400);
  const accepted=await f.request("/api/owner-leno/grant",{method:"POST",body:grant});
  assert.equal(accepted.status,200);
  assert.equal(accepted.data.revision,1);
  const applied=await f.request("/api/owner-leno/enforcement",{method:"POST",body:{
    revision:1,enabled:true,confirmation:"ENFORCE Leno GRANTS"}});
  assert.equal(applied.status,200);
  const rollback=await f.request("/api/owner-leno/enforcement",{method:"POST",body:{
    revision:2,enabled:false,confirmation:"RESTORE Leno LEGACY ACCESS"}});
  assert.equal(rollback.status,200);
  const pushed=f.history.filter(x=>x.kind==="relay");
  assert.deepEqual(pushed.map(x=>x.url),[
    "/owner/leno/grant","/owner/leno/enforcement","/owner/leno/enforcement"]);
  assert.equal(JSON.stringify(pushed).includes("simulated-session-bearer"),false);
});
test("unknown owner route and wrong methods return immediately",async t=>{
  const f=await setup(t);
  assert.equal((await f.request("/api/owner-leno/unknown")).status,404);
  assert.equal((await f.request("/api/owner-leno",{method:"POST",body:grant})).status,405);
});
test("OAuth portal additive loading leaves exact supplied HTML and V5 authority handler in place",async()=>{
  const oauth=await readFile(fileURLToPath(new URL("../oauth.mjs",import.meta.url)),"utf8");
  const ui=await readFile(fileURLToPath(new URL("../public/tp-owner-leno.js",import.meta.url)),"utf8");
  assert.match(oauth,/new OwnerLenoPortalProxy\(this\)/);
  assert.match(oauth,/raw\.startsWith\('\/api\/owner-leno'\)/);
  assert.match(oauth,/this\.authority\.handle\(req,res\)/);
  assert.match(oauth,/original,Buffer\.from\('\\n'\),oauth/);
  assert.match(oauth,/tp-owner-leno\.js/);
  assert.match(ui,/RESTORE Leno LEGACY ACCESS/);
  assert.match(ui,/TRUST Leno/);
  assert.match(ui,/Owner Full Control|OWNER FULL CONTROL/);
});
