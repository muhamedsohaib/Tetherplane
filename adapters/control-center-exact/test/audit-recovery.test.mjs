import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,unlinkSync,writeFileSync,readFileSync,appendFileSync,openSync,closeSync,existsSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AuthorityRegistry,AuthorityError} from '../authority.mjs';
import {provisionAuthorityAudit} from '../authority-audit.mjs';

const issuer='https://issuer.test.invalid/';
const resource='https://relay.test.invalid/mcp';
const token=['eyJhbGciOiJSUzI1NiJ9',Buffer.from(JSON.stringify({
  iss:issuer,sub:'recovery-owner',aud:resource,scope:'tetherplane:access',exp:3000000000
})).toString('base64url'),'test-signature'].join('.');
const portal={
  directory:async()=>[{deviceId:'Leno',pairedAt:'2026-10-25T01:00:00Z',revokedAt:null}],
  mcpCall:async()=>({isError:false,structuredContent:{providers:[]}})
};
const create=()=>{
  const root=mkdtempSync(join(tmpdir(),'tp-journal-loss-'));
  const config={journalPath:join(root,'journal.jsonl'),
    checkpointPath:join(root,'checkpoint.json'),auditKey:Buffer.alloc(32,14).toString('base64'),
    issuer,resource,adminSubjects:['recovery-owner']};
  return {root,config,cleanup:()=>rmSync(root,{force:true,recursive:true})};
};
const isAuditFailure=e=>e instanceof AuthorityError&&e.code==='audit_integrity_failed';

test('unprovisioned audit state cannot silently initialize to unrestricted on boot',()=>{
  const f=create();try{
    assert.throws(()=>new AuthorityRegistry(portal,f.config),isAuditFailure);
  }finally{f.cleanup();}
});
test('loss of audit journal after a confirmed restriction fails closed on restart',async()=>{
  const f=create();try{
    provisionAuthorityAudit(f.config);
    const registry=new AuthorityRegistry(portal,f.config);
    await registry.change({token,deviceId:'Leno',denied:['filesystem'],expectedRevision:0,
      confirmDeviceId:'Leno',reason:'Restrict files until owner review'});
    unlinkSync(f.config.journalPath);
    assert.throws(()=>new AuthorityRegistry(portal,f.config),isAuditFailure);
  }finally{f.cleanup();}
});
test('truncated zero-length audit cannot restore unrestricted access after restart',async()=>{
  const f=create();try{
    provisionAuthorityAudit(f.config);
    const registry=new AuthorityRegistry(portal,f.config);
    await registry.change({token,deviceId:'Leno',denied:['filesystem'],expectedRevision:0,
      confirmDeviceId:'Leno',reason:'Restrict files until owner review'});
    writeFileSync(f.config.journalPath,'');
    assert.throws(()=>new AuthorityRegistry(portal,f.config),isAuditFailure);
  }finally{f.cleanup();}
});

test('a missing checkpoint or both missing storage files fail closed',async()=>{
  const f=create();try{
    provisionAuthorityAudit(f.config);
    const registry=new AuthorityRegistry(portal,f.config);
    await registry.change({token,deviceId:'Leno',denied:['filesystem'],expectedRevision:0,
      confirmDeviceId:'Leno',reason:'Owner restricts files before rollback'});
    unlinkSync(f.config.checkpointPath);
    assert.throws(()=>new AuthorityRegistry(portal,f.config),isAuditFailure);
    unlinkSync(f.config.journalPath);
    assert.throws(()=>new AuthorityRegistry(portal,f.config),isAuditFailure);
  }finally{f.cleanup();}
});
test('backed-up matching audit and checkpoint restore restrictions; stale journal is rejected',async()=>{
  const f=create();try{
    provisionAuthorityAudit(f.config);
    const registry=new AuthorityRegistry(portal,f.config);
    await registry.change({token,deviceId:'Leno',denied:['filesystem'],expectedRevision:0,
      confirmDeviceId:'Leno',reason:'Owner restricts files before rollback'});
    const oldJournal=readFileSync(f.config.journalPath);
    const oldCheckpoint=readFileSync(f.config.checkpointPath);
    await registry.change({token,deviceId:'Leno',denied:['filesystem','browser'],expectedRevision:1,
      confirmDeviceId:'Leno',reason:'Extend restrictions for review'});
    const newerJournal=readFileSync(f.config.journalPath);
    const newerCheckpoint=readFileSync(f.config.checkpointPath);
    writeFileSync(f.config.journalPath,oldJournal);
    assert.throws(()=>new AuthorityRegistry(portal,f.config),isAuditFailure);
    writeFileSync(f.config.checkpointPath,oldCheckpoint);
    const restored=new AuthorityRegistry(portal,f.config);
    assert.deepEqual(restored.state(token,'Leno').denied,['filesystem']);
    writeFileSync(f.config.journalPath,newerJournal);
    writeFileSync(f.config.checkpointPath,newerCheckpoint);
    const newest=new AuthorityRegistry(portal,f.config);
    assert.deepEqual(newest.state(token,'Leno').denied,['browser','filesystem']);
  }finally{f.cleanup();}
});
test('checkpoint corruption or an unauthorized substitute MAC key denies startup',async()=>{
  const f=create();try{
    provisionAuthorityAudit(f.config);
    const registry=new AuthorityRegistry(portal,f.config);
    const checkpoint=readFileSync(f.config.checkpointPath);
    writeFileSync(f.config.checkpointPath,Buffer.from(checkpoint.toString().replace('"count":0','"count":4')));
    assert.throws(()=>new AuthorityRegistry(portal,f.config),isAuditFailure);
    writeFileSync(f.config.checkpointPath,checkpoint);
    const wrongKey={...f.config,auditKey:Buffer.alloc(32,15).toString('base64')};
    assert.throws(()=>new AuthorityRegistry(portal,wrongKey),isAuditFailure);
    assert.equal(registry.state(token,'Leno').revision,0);
  }finally{f.cleanup();}
});
test('partial transaction after journal fsync but before checkpoint advance denies restart',async()=>{
  const f=create();try{
    provisionAuthorityAudit(f.config);
    const registry=new AuthorityRegistry(portal,f.config);
    await registry.change({token,deviceId:'Leno',denied:['filesystem'],expectedRevision:0,
      confirmDeviceId:'Leno',reason:'Protect owner files during review'});
    const last=JSON.parse(readFileSync(f.config.journalPath,'utf8').trim());
    const next={seq:2,account:last.account,device:'Leno',revision:2,
      action:'rollback',before:['filesystem'],after:[],
      reason:'Synthetic interrupted transaction',time:'2026-10-25T02:00:00Z',prev:last.mac};
    next.mac=createHmac('sha256',Buffer.from(f.config.auditKey,'base64'))
      .update(JSON.stringify(next)).digest('hex');
    appendFileSync(f.config.journalPath,JSON.stringify(next)+'\n');
    assert.throws(()=>new AuthorityRegistry(portal,f.config),isAuditFailure);
    assert.throws(()=>registry.enforceVerified(token,'Leno','device','status'),isAuditFailure);
  }finally{f.cleanup();}
});
test('explicit first-use provisioning refuses to overwrite even partial storage',()=>{
  const f=create();try{
    provisionAuthorityAudit(f.config);
    const original=readFileSync(f.config.checkpointPath);
    assert.throws(()=>provisionAuthorityAudit(f.config),/already exists/);
    assert.deepEqual(readFileSync(f.config.checkpointPath),original);
    unlinkSync(f.config.journalPath);
    assert.throws(()=>provisionAuthorityAudit(f.config),/already exists/);
    assert.deepEqual(readFileSync(f.config.checkpointPath),original);
  }finally{f.cleanup();}
});

test('an existing writer lease blocks changes without mutating either audit file',async()=>{
  const f=create();let lockFd;try{
    provisionAuthorityAudit(f.config);
    const first=new AuthorityRegistry(portal,f.config);
    const journalBefore=readFileSync(f.config.journalPath);
    const checkpointBefore=readFileSync(f.config.checkpointPath);
    const lockPath=f.config.journalPath+'.writer.lock';
    lockFd=openSync(lockPath,'wx');
    await assert.rejects(()=>first.change({token,deviceId:'Leno',denied:['filesystem'],
      expectedRevision:0,confirmDeviceId:'Leno',reason:'Test concurrent writer protection'}),
      e=>e instanceof AuthorityError&&e.code==='authority_writer_busy');
    assert.deepEqual(readFileSync(f.config.journalPath),journalBefore);
    assert.deepEqual(readFileSync(f.config.checkpointPath),checkpointBefore);
    assert.equal(existsSync(lockPath),true);
    closeSync(lockFd);lockFd=undefined;unlinkSync(lockPath);
    const result=await first.change({token,deviceId:'Leno',denied:['filesystem'],
      expectedRevision:0,confirmDeviceId:'Leno',reason:'Acquire single writer lease after review'});
    assert.equal(result.revision,1);
    assert.equal(existsSync(lockPath),false);
    assert.deepEqual(new AuthorityRegistry(portal,f.config).state(token,'Leno').denied,['filesystem']);
  }finally{if(lockFd!==undefined)closeSync(lockFd);f.cleanup();}
});
