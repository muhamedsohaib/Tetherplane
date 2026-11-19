import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ExactPortal } from '../server.mjs';

const uiUrl=new URL('../public/index.html',import.meta.url);
const approvedHtmlPresent=existsSync(uiUrl);
const htmlTestUrl=approvedHtmlPresent?uiUrl:new URL('./fixture.html',import.meta.url);
const SEED=[{deviceId:'Leno',pairedAt:'2026-10-01T01:00:00Z',revokedAt:null},{deviceId:'Surface',pairedAt:'2026-10-01T01:00:00Z',revokedAt:null}];
let approveCount=0,revokeCount=0,mcpCount=0,mcpDeletes=0,mcpTool=null,lastMcpArgs=null;
let data=structuredClone(SEED),denyTool=false,now=Date.now();
const relay=createServer(async(req,res)=>{
  const chunks=[];for await(const b of req)chunks.push(b);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
  const write=(status,x,extra={})=>{res.writeHead(status,{'content-type':'application/json',...extra});res.end(JSON.stringify(x));};
  if(req.headers.authorization!=='Bearer correct'){write(401,{error:'unauthorized'});return;}
  if(req.method==='GET'&&req.url==='/devices'){write(200,{devices:data});return;}
  if(req.method==='POST'&&req.url==='/pair/approve'){approveCount++;if(body.userCode!=='AB12-CD34'){write(400,{error:'bad code'});return;}let item={deviceId:'RTX',pairedAt:'2026-10-20T01:00:00Z',revokedAt:null};data.push(item);write(200,item);return;}
  if(req.method==='POST'&&req.url==='/devices/Leno/revoke'){revokeCount++;data[0].revokedAt='2026-10-20T02:00:00Z';write(200,data[0]);return;}
  if(req.method==='DELETE'&&req.url==='/mcp'){mcpDeletes++;assert.equal(req.headers['mcp-session-id'],'sid123');res.writeHead(202);res.end();return;}
  if(req.method==='POST'&&req.url==='/mcp'){
    mcpCount++;
    if(body.method==='initialize'){write(200,{jsonrpc:'2.0',id:1,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'relay',version:'0.1.0'}}},{'mcp-session-id':'sid123'});return;}
    if(body.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
    if(body.method==='tools/call'){
      mcpTool=body.params.name;lastMcpArgs=body.params.arguments;
      write(200,{jsonrpc:'2.0',id:2,result:{content:[{type:'text',text:'permission_denied'}],isError:denyTool,structuredContent:{code:denyTool?'permission_denied':'ok',requested:body.params.arguments.op}}});return;
    }
  }
  write(404,{error:'not found'});
});
await new Promise(r=>relay.listen(0,'127.0.0.1',r));
const relayUrl=`http://127.0.0.1:${relay.address().port}`;
const portal=new ExactPortal({relayUrl,now:()=>now,htmlPath:fileURLToPath(htmlTestUrl)});
const origin=await portal.listen(0);
after(async()=>{await portal.close();await new Promise(r=>relay.close(r));});
const browser={cookie:null,csrf:null};
async function call(path,method='GET',body=null,{auth=true,csrf=true,originHeader=true,cookie=true,host=true}={}){
  const response=await fetch(origin+path,{method,redirect:'manual',headers:{...(originHeader&&method==='POST'?{'origin':origin}:{}),...(method==='POST'?{'content-type':'application/json'}:{}),...(cookie&&browser.cookie?{'cookie':browser.cookie}:{}),...(csrf&&browser.csrf?{'x-csrf-token':browser.csrf}:{}),...(host?{}:{'host':'attacker.example'})},...(method==='POST'?{body:JSON.stringify(body)}:{})});
  let result;try{result=await response.json();}catch{result=null;}
  return {status:response.status,response,result};
}
async function login(){const r=await call('/api/session','POST',{token:'correct'},{csrf:false});assert.equal(r.status,200);browser.cookie=r.response.headers.get('set-cookie').split(';')[0];browser.csrf=r.result.csrfToken;return r;}

test('runtime boot script preserves source HTML unchanged (visual hash enforced when owner asset exists)',async()=>{
  const src=await readFile(htmlTestUrl);
  if(approvedHtmlPresent) assert.equal(createHash('sha256').update(src).digest('hex'),'36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82');
  const response=await fetch(origin);const html=await response.text();
  assert.ok(html.includes('<script src="/tp-integration.js" defer></script>'));
  assert.equal(html.replace('<script src="/tp-integration.js" defer></script>\n',''),src.toString('utf8'));
  assert.equal(response.headers.get('x-frame-options'),'DENY');
  assert.equal(response.headers.get('cache-control'),'no-store');
  const js=await fetch(origin+'/tp-integration.js');assert.equal(js.status,200);assert.match(await js.text(),/mcpCall|mcp\/call/);
});

test('denies unbound requests, cross-origin POSTs, wrong content type and wrong relay credential',async()=>{
  assert.equal((await call('/api/devices')).status,401);
  assert.equal((await call('/api/session','POST',{token:'wrong'},{csrf:false})).status,401);
  assert.equal((await call('/api/session','POST',{token:'correct'},{csrf:false,originHeader:false})).status,403);
  const x=await fetch(origin+'/api/session',{method:'POST',headers:{origin,'content-type':'text/plain'},body:'bad'});assert.equal(x.status,415);
  const hostCheck=await new Promise((resolve,reject)=>{const u=new URL(origin);const r=httpRequest({hostname:u.hostname,port:u.port,path:'/api/devices',headers:{host:'attacker.example'}},x=>{x.resume();x.once('end',()=>resolve(x.statusCode));});r.once('error',reject);r.end();}); assert.equal(hostCheck,403);
});

test('authentication establishes session with server-only credential, safe directory and CSRF',async()=>{
  const r=await login();assert.equal(r.result.devices.length,2);assert.equal(r.result.devices[0].connectivity,'not_reported');assert.ok(r.result.expiresAt);assert.equal(r.result.relayOrigin,relayUrl);
  assert.match(r.response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.ok(!JSON.stringify(r.result).includes('correct'));
  assert.equal((await call('/api/devices')).status,200);
  assert.equal((await call('/api/pair/approve','POST',{userCode:'AB12-CD34',confirmOwnership:true},{csrf:false})).status,403);
});

test('pairing validates ownership, rejects invalid codes, and approves only confirmed codes',async()=>{
  assert.equal((await call('/api/pair/approve','POST',{userCode:'ZZZZ-ZZZZ',confirmOwnership:true})).status,400);
  assert.equal((await call('/api/pair/approve','POST',{userCode:'AB12-CD34',confirmOwnership:false})).status,400);
  assert.equal(approveCount,0);
  const rejected=await call('/api/pair/approve','POST',{userCode:'0000-0000',confirmOwnership:true});
  assert.equal(rejected.status,400);assert.equal(rejected.result.error.code,'pairing_rejected');
  const r=await call('/api/pair/approve','POST',{userCode:'AB12-CD34',confirmOwnership:true});
  assert.equal(r.status,200);assert.equal(r.result.deviceId,'RTX');assert.equal(approveCount,2);
  assert.equal((await call('/api/devices')).result.devices.length,3);
});

test('revoke requires exact device id and current account ownership',async()=>{
  assert.equal((await call('/api/devices/NotOwned/revoke','POST',{confirmDeviceId:'NotOwned'})).status,403);
  assert.equal((await call('/api/devices/Leno/revoke','POST',{confirmDeviceId:'leno'})).status,400);
  assert.equal(revokeCount,0);
  const revoked=await call('/api/devices/Leno/revoke','POST',{confirmDeviceId:'Leno'});
  assert.equal(revoked.status,200);assert.equal(revokeCount,1);
  assert.equal((await call('/api/devices')).result.devices[0].revokedAt,'2026-10-20T02:00:00Z');
  assert.equal((await call('/api/devices/Leno/revoke','POST',{confirmDeviceId:'Leno'})).status,403);
});

test('MCP proxy negotiates existing protocol and forwards six-tool operation without bypassing policy',async()=>{
  assert.equal((await call('/api/mcp/call','POST',{tool:'seventh',op:'status',device:'Surface',args:{}})).status,400);
  assert.equal((await call('/api/mcp/call','POST',{tool:'device',op:'status',device:'NotOwned',args:{}})).status,403);
  assert.equal(mcpCount,0);
  const r=await call('/api/mcp/call','POST',{tool:'device',op:'status',device:'Surface',args:{}});
  assert.equal(r.status,200);assert.equal(mcpTool,'device');assert.equal(lastMcpArgs.device,'Surface');assert.equal(lastMcpArgs.op,'status');
  assert.equal(mcpCount,3);assert.equal(mcpDeletes,1);
  denyTool=true;
  const denied=await call('/api/mcp/call','POST',{tool:'files',op:'read',device:'Surface',args:{path:'C:/outside'}});
  assert.equal(denied.status,200);assert.equal(denied.result.result.isError,true);assert.equal(denied.result.result.structuredContent.code,'permission_denied');
  assert.equal(mcpDeletes,2);denyTool=false;
});

test('session expiry fails closed and no implicit reuse of expired credentials',async()=>{
  now+=TTL_PLUS_1;
  assert.equal((await call('/api/devices')).status,401);
  assert.equal((await call('/api/mcp/call','POST',{tool:'device',op:'status',device:'Surface',args:{}})).status,401);
  now-=TTL_PLUS_1;
});
const TTL_PLUS_1=900001;

test('signout clears server session and prevents later use',async()=>{
  await login();assert.equal((await call('/api/logout','POST',{})).status,200);
  assert.equal((await call('/api/devices')).status,401);
});
