import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AuthorityRegistry,AuthorityError} from '../authority.mjs';
import {provisionAuthorityAudit} from '../authority-audit.mjs';

const issuer='https://issuer.test.invalid/';
const resource='https://relay.test.invalid/mcp';
const allowedGroups=['filesystem','process','browser','desktop','batch'];
const sign=(sub)=>['eyJhbGciOiJSUzI1NiJ9',Buffer.from(JSON.stringify({
  iss:issuer,sub,aud:resource,scope:'tetherplane:access',exp:3000000000
})).toString('base64url'),'fake-signature'].join('.');
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'tp-authority-tests-'));
  const admin=sign('owner-approved-subject'),other=sign('other-account-subject');
  const calls=[];
  const portal={
    directory:async token=>{
      if(![admin,other].includes(token))throw Object.assign(Error('invalid access token'),{status:401});
      return [{deviceId:'Leno',pairedAt:'2026-10-24T12:00:00.000Z',revokedAt:null},
        {deviceId:'VAULTER',pairedAt:'2026-10-24T12:00:00.000Z',revokedAt:null}];
    },
    mcpCall:async(token,tool,op,device,args)=>{
      calls.push({tool,op,device,args});
      if(device==='VAULTER')return {isError:false,structuredContent:{providers:[
        {namespace:'device',available:true,operations:['status','capabilities']},
        {namespace:'filesystem',available:true,operations:['read','list']},
        {namespace:'process',available:true,operations:[]},
        {namespace:'browser',available:false,operations:[]}
      ]}};
      return {isError:false,structuredContent:{providers:[
        {namespace:'device',available:true,operations:['status','capabilities']},
        {namespace:'filesystem',available:true,operations:['read','list','write']},
        {namespace:'process',available:true,operations:['run']},
        {namespace:'browser',available:false,operations:[]},
        {namespace:'desktop',available:true,operations:['snapshot']},
        {namespace:'batch',available:true,operations:['execute']}
      ]}};
    }
  };
  const config={journalPath:join(root,'authority.jsonl'),
    checkpointPath:join(root,'checkpoint.json'),auditKey:Buffer.alloc(32,12).toString('base64'),
    issuer,resource,adminSubjects:['owner-approved-subject'],now:()=>new Date('2026-10-25T06:00:00Z')};
  provisionAuthorityAudit(config);
  const registry=new AuthorityRegistry(portal,config);
  return {registry,root,admin,other,portal,calls,config,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
const apply=(f,overrides={})=>f.registry.change({
  token:f.admin,deviceId:'Leno',denied:['filesystem'],expectedRevision:0,
  confirmDeviceId:'Leno',reason:'Restrict portal file access for testing',
  ...overrides
});
const rejectCode=async(fn,code)=>assert.rejects(()=>Promise.resolve().then(fn),e=>e instanceof AuthorityError&&e.code===code);

test('live capability discovery reflects device advertised operations, not blanket authorization',async()=>{
  const f=fixture();try {
    const a=await f.registry.observe(f.admin,'VAULTER');
    assert.equal(a.deviceId,'VAULTER');
    assert.deepEqual(a.providers.find(x=>x.namespace==='filesystem').operations,['read','list']);
    assert.deepEqual(a.providers.find(x=>x.namespace==='process').operations,[]);
    assert.equal(a.source,'agent_device.capabilities');
    assert.equal(a.authorityScope,'control_center_only');
    assert.equal(a.isOwner,true);
    assert.equal(a.revision,0);
    assert.equal(f.calls.length,1);
    assert.deepEqual(f.calls[0],{tool:'device',op:'capabilities',device:'VAULTER',args:{}});
    const other=await f.registry.observe(f.other,'Leno');
    assert.equal(other.isOwner,false);
  }finally{f.cleanup()}
});
test('verified non-owner and mismatched account device cannot mutate portal policy',async()=>{
  const f=fixture();try {
    await rejectCode(()=>apply(f,{token:f.other}), 'owner_approval_required');
    await rejectCode(()=>apply(f,{deviceId:'NotMyDevice',confirmDeviceId:'NotMyDevice'}),'device_not_paired');
    await rejectCode(()=>apply(f,{confirmDeviceId:'Surface'}),'confirmation_required');
    await rejectCode(()=>apply(f,{denied:['device']}),'invalid_authority_change');
    assert.equal(f.registry.state(f.admin,'Leno').revision,0);
  }finally{f.cleanup()}
});
test('restricting a device is durable, audited and denies portal MCP calls including batch/process bypasses',async()=>{
  const f=fixture();try {
    const receipt=await apply(f);
    assert.equal(receipt.revision,1);
    assert.deepEqual(receipt.denied,['filesystem']);
    assert.equal(receipt.audit.action,'restrict');
    assert.equal(receipt.audit.revision,1);
    const restored=new AuthorityRegistry(f.portal,f.config);
    assert.deepEqual(restored.state(f.admin,'Leno').denied,['filesystem']);
    await rejectCode(()=>restored.enforceVerified(f.admin,'Leno','files','read'),'portal_authority_denied');
    await rejectCode(()=>restored.enforceVerified(f.admin,'Leno','batch','execute'),'portal_authority_denied');
    await rejectCode(()=>restored.enforceVerified(f.admin,'Leno','process','run'),'portal_authority_denied');
    assert.equal(restored.enforceVerified(f.admin,'Leno','device','status'),true);
    await rejectCode(()=>restored.enforceVerified(f.admin,'Leno','device','shutdown'),'portal_authority_denied');
    assert.equal(restored.enforceVerified(f.admin,'VAULTER','files','read'),true);
    assert.equal(restored.state(f.other,'Leno').revision,0);
    assert.equal(restored.audit(f.admin,'Leno').length,1);
    assert.equal(JSON.stringify(restored.audit(f.admin,'Leno')).includes(f.admin),false);
  }finally{f.cleanup()}
});
test('stale revision cannot overwrite a concurrent restriction',async()=>{
  const f=fixture();try{
    await apply(f);
    await rejectCode(()=>apply(f,{denied:[],expectedRevision:0}), 'revision_conflict');
    assert.deepEqual(f.registry.state(f.admin,'Leno').denied,['filesystem']);
    assert.equal(f.registry.audit(f.admin,'Leno').length,1);
  }finally{f.cleanup()}
});
test('typed, reasoned owner rollback restores only the earlier portal overlay, with a second audit entry',async()=>{
  const f=fixture();try {
    await apply(f);
    await f.registry.change({token:f.admin,deviceId:'Leno',denied:['filesystem','browser'],
      expectedRevision:1,confirmDeviceId:'Leno',reason:'Add browser protection for review'});
    const receipt=await f.registry.rollback({token:f.admin,deviceId:'Leno',
      confirmDeviceId:'Leno',expectedRevision:2,targetRevision:1,
      reason:'Restore previous reviewed restriction state'});
    assert.equal(receipt.revision,3);
    assert.deepEqual(receipt.denied,['filesystem']);
    assert.equal(receipt.audit.action,'rollback');
    assert.equal(f.registry.audit(f.admin,'Leno').length,3);
    assert.equal(f.registry.enforceVerified(f.admin,'Leno','desktop','snapshot'),true);
    await rejectCode(()=>f.registry.rollback({token:f.admin,deviceId:'Leno',
      confirmDeviceId:'Leno',expectedRevision:3,targetRevision:90,
      reason:'Invalid nonexistent rollback target'}),'invalid_revision');
  }finally{f.cleanup()}
});
test('audit corruption stops authorization decisions instead of silently allowing operations',async()=>{
  const f=fixture();try{
    await apply(f);
    const path=f.config.journalPath;
    const text=readFileSync(path,'utf8');
    writeFileSync(path,text.replace('filesystem','desktop'));
    await rejectCode(()=>f.registry.enforceVerified(f.admin,'Leno','device','status'),'audit_integrity_failed');
    await rejectCode(()=>f.registry.change({token:f.admin,deviceId:'Leno',denied:[],
      expectedRevision:1,confirmDeviceId:'Leno',reason:'Attempt corrupt journal update'}),'audit_integrity_failed');
  }finally{f.cleanup()}
});
test('empty administrator allowlist is read-only and never creates an implicit administrator',async()=>{
  const f=fixture();try{
    const r=new AuthorityRegistry(f.portal,{...f.config,adminSubjects:[]});
    assert.equal((await r.observe(f.admin,'Leno')).isOwner,false);
    await rejectCode(()=>r.change({token:f.admin,deviceId:'Leno',denied:['process'],
      expectedRevision:0,confirmDeviceId:'Leno',reason:'Try unauthorized change request'}),'owner_approval_required');
    assert.equal(r.audit(f.admin,'Leno').length,0);
  }finally{f.cleanup()}
});
test('malformed capability response fails closed rather than showing false permissions',async()=>{
  const f=fixture();try{
    f.portal.mcpCall=async()=>({isError:true,structuredContent:{code:'permission_denied'}});
    await rejectCode(()=>f.registry.observe(f.admin,'Leno'),'capability_discovery_denied');
  }finally{f.cleanup()}
});
