import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OAuthPortal} from '../oauth.mjs';
import {provisionAuthorityAudit} from '../authority-audit.mjs';

const issuer='https://issuer.test.invalid/';
const resource='https://relay.test.invalid/mcp';
const token=['eyJhbGciOiJSUzI1NiJ9',
  Buffer.from(JSON.stringify({iss:issuer,sub:'owner-sub',aud:resource,
    scope:'tetherplane:access',exp:3000000000})).toString('base64url'),
  'fake-signature'].join('.');
const root=mkdtempSync(join(tmpdir(),'tp-authority-http-'));
let toolCalls=0;
const relay=createServer(async(req,res)=>{
  const chunks=[];for await(const b of req)chunks.push(b);
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
  const json=(v,code=200,extra={})=>{
    res.writeHead(code,{'content-type':'application/json',...extra});
    res.end(JSON.stringify(v));
  };
  if(req.url==='/devices')return json({devices:[
    {deviceId:'Leno',pairedAt:'2026-10-24T12:00:00Z',revokedAt:null},
    {deviceId:'VAULTER',pairedAt:'2026-10-24T12:00:00Z',revokedAt:null}
  ]});
  if(req.url==='/mcp'){
    if(req.method==='DELETE'){res.writeHead(202);res.end();return;}
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(body.method==='initialize')return json({jsonrpc:'2.0',id:1,
      result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}},200,{'mcp-session-id':'sid-test'});
    if(body.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
    if(body.method==='tools/call'){
      toolCalls++;
      const p=body.params;
      if(p.name==='device'&&p.arguments.op==='capabilities'){
        return json({jsonrpc:'2.0',id:2,result:{isError:false,structuredContent:{providers:[
          {namespace:'device',available:true,operations:['status','capabilities']},
          {namespace:'filesystem',available:true,operations:['read','write']},
          {namespace:'process',available:true,operations:['run']},
          {namespace:'browser',available:false,operations:[]}
        ]}}});
      }
      return json({jsonrpc:'2.0',id:2,result:{isError:false,structuredContent:{ok:true}}});
    }
  }
  json({error:'not found'},404);
});
await new Promise(ok=>relay.listen(0,'127.0.0.1',ok));
const authority={journalPath:join(root,'audit.jsonl'),
  checkpointPath:join(root,'checkpoint.json'),auditKey:Buffer.alloc(32,4).toString('base64'),
  issuer,resource,adminSubjects:['owner-sub']};
provisionAuthorityAudit(authority);
const portal=new OAuthPortal({
  relayUrl:'http://127.0.0.1:'+relay.address().port,
  authority
});
const origin=await portal.listen(0);
const cookie=portal.cookieName+'=approved';
const csrf='csrf-for-real-api-test';
portal.sessions.set('approved',{token,csrf,expires:Date.now()+180000});
after(async()=>{await portal.close();await new Promise(ok=>relay.close(ok));rmSync(root,{recursive:true,force:true})});
const api=async(path,method='GET',body,settings={})=>{
 const response=await fetch(origin+path,{
  redirect:'manual',method,
  headers:{
    ...(settings.auth===false?{}:{cookie}),
    ...(method==='POST'?{'content-type':'application/json',origin}:{}),
    ...(settings.csrf===false?{}:{'x-csrf-token':csrf}),
    ...(settings.origin===false?{origin:'http://attacker.example'}:{})
  },
  ...(method==='POST'?{body:JSON.stringify(body)}:{})
 });
 return {status:response.status,body:await response.json()};
};
test('unauthenticated authority API denied, and direct device authority discovery returns live operations',async()=>{
 assert.equal((await api('/api/authority/Leno','GET',null,{auth:false})).status,401);
 const r=await api('/api/authority/Leno');
 assert.equal(r.status,200);
 assert.equal(r.body.source,'agent_device.capabilities');
 assert.equal(r.body.providers.find(x=>x.namespace==='filesystem').operations[1],'write');
 assert.equal(r.body.agentPolicyModifiable,false);
 assert.equal(r.body.authorityScope,'control_center_only');
 assert.equal(r.body.revision,0);
});
test('requires origin, CSRF, exact device confirmation, and persisted revision before changes',async()=>{
 const body={denied:['filesystem'],expectedRevision:0,confirmDeviceId:'Leno',reason:'Review restricted filesystem'};
 assert.equal((await api('/api/authority/Leno/change','POST',body,{csrf:false})).status,403);
 assert.equal((await api('/api/authority/Leno/change','POST',body,{origin:false})).status,403);
 assert.equal((await api('/api/authority/Leno/change','POST',{...body,confirmDeviceId:'Other'})).status,400);
 const changed=await api('/api/authority/Leno/change','POST',body);
 assert.equal(changed.status,200);
 assert.equal(changed.body.revision,1);
 assert.deepEqual(changed.body.denied,['filesystem']);
 const stale=await api('/api/authority/Leno/change','POST',{...body,denied:[],reason:'Try stale revision state'});
 assert.equal(stale.status,409);
 assert.equal(stale.body.error.code,'revision_conflict');
});
test('portal MCP gateway blocks denied operations before sending RPC; still allows status',async()=>{
 const before=toolCalls;
 const denied=await api('/api/mcp/call','POST',{tool:'files',op:'read',device:'Leno',args:{path:'C:/workspace'}});
 assert.equal(denied.status,403);
 assert.equal(denied.body.error.code,'portal_authority_denied');
 assert.equal(toolCalls,before);
 const batch=await api('/api/mcp/call','POST',{tool:'batch',op:'execute',device:'Leno',args:{invocations:[]}});
 assert.equal(batch.status,403);
 const privileged=await api('/api/mcp/call','POST',{tool:'device',op:'shutdown',device:'Leno',args:{}});
 assert.equal(privileged.status,403);
 assert.equal(toolCalls,before,'restricted device operation must never reach MCP');
 const status=await api('/api/mcp/call','POST',{tool:'device',op:'status',device:'Leno',args:{}});
 assert.equal(status.status,200);
});
test('rollback restores prior portal policy through authorized and audited API',async()=>{
 const result=await api('/api/authority/Leno/rollback','POST',
   {expectedRevision:1,targetRevision:0,confirmDeviceId:'Leno',reason:'Restore original portal policy'});
 assert.equal(result.status,200);
 assert.deepEqual(result.body.denied,[]);
 assert.equal(result.body.revision,2);
 const observed=await api('/api/authority/Leno');
 assert.equal(observed.status,200);
 assert.equal(observed.body.audit.length,2);
 const after=await api('/api/mcp/call','POST',{tool:'files',op:'read',device:'Leno',args:{path:'C:/workspace'}});
 assert.equal(after.status,200);
});

test('unexpected authority mutation failure never falsely confirms that no change was applied',async()=>{
 const original=portal.authority.registry.change;
 portal.authority.registry.change=async()=>{throw Error('synthetic interrupted response after possible write')};
 try {
   const r=await api('/api/authority/Leno/change','POST',
     {denied:['filesystem'],expectedRevision:2,confirmDeviceId:'Leno',
      reason:'Synthetic post-write response failure'});
   assert.equal(r.status,503);
   assert.equal(r.body.error.code,'authority_unavailable');
   assert.match(r.body.error.message,/uncertain|verify|refresh/i);
   assert.doesNotMatch(r.body.error.message,/No change was applied/i);
 }finally{portal.authority.registry.change=original}
});
