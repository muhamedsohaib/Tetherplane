import {createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {readFileSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {verifyAuditCheckpoint,advanceAuditCheckpoint,withAuthorityWriterLease,AuthorityWriterBusy} from './authority-audit.mjs';
import {isAbsolute} from 'node:path';
import {effectiveInventory,portalDenied,checkedProbe,classifyProbeReply,localReviewFields} from './authority-access.mjs';

export class AuthorityError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
const fail=(status,code,message)=>{throw new AuthorityError(status,code,message);};
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_GROUPS=new Set(['filesystem','process','browser','desktop','batch']);
const toolGroup={files:'filesystem',filesystem:'filesystem',process:'process',browser:'browser',desktop:'desktop',batch:'batch',device:'device'};
const MAX_JOURNAL=4*1024*1024;
const sha=x=>createHash('sha256').update(x).digest('hex');
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const clone=a=>[...a];
function validatedClaims(token,issuer,resource,now) {
  // Must be invoked only after the existing relay verified this token's signature,
  // issuer, audience, expiry, client binding, account binding and access scope.
  if(typeof token!=='string'||token.length>8192||token.split('.').length!==3)
    fail(403,'owner_approval_required','Only validated OIDC sessions can manage portal authority.');
  let p;try{p=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));}catch{
    fail(403,'owner_approval_required','An OIDC access token is required.');}
  if(!obj(p)||p.iss!==issuer||typeof p.sub!=='string'||p.sub.length<1||p.sub.length>256||
      /[\x00-\x1f\x7f]/.test(p.sub)||
      !(p.aud===resource||(Array.isArray(p.aud)&&p.aud.includes(resource)))||
      !Number.isFinite(p.exp)||p.exp*1000<=now().getTime()||
      !(p.scope===undefined||typeof p.scope==='string'&&p.scope.split(' ').includes('tetherplane:access'))){
    fail(403,'owner_approval_required','The current identity cannot manage portal authority.');
  }
  return {sub:p.sub,key:sha(issuer+'\0'+p.sub)};
}
function validateGroups(list){
  if(!Array.isArray(list)||list.length>SAFE_GROUPS.size||
    list.some(x=>typeof x!=='string'||!SAFE_GROUPS.has(x))||
    new Set(list).size!==list.length)fail(400,'invalid_authority_change','Choose supported capability groups only.');
  return [...list].sort();
}
function validateReason(reason){
  if(typeof reason!=='string'||reason.length<8||reason.length>200||
    /[\x00-\x1f\x7f]/.test(reason))fail(400,'confirmation_required','Provide a short, specific change reason without line breaks.');
  return reason;
}
function validateDevice(device){
  if(typeof device!=='string'||!SAFE_ID.test(device))fail(400,'invalid_device_id','Invalid device ID.');
}
function validateRevision(revision){
  if(!Number.isSafeInteger(revision)||revision<0||revision>1000000)
    fail(400,'invalid_revision','Invalid policy revision.');
}
function validJournalRecord(r){
  return obj(r)&&Number.isSafeInteger(r.seq)&&r.seq>0&&
    typeof r.account==='string'&&/^[a-f0-9]{64}$/.test(r.account)&&
    typeof r.device==='string'&&SAFE_ID.test(r.device)&&
    Number.isSafeInteger(r.revision)&&r.revision>=1&&
    (r.action==='restrict'||r.action==='rollback')&&
    Array.isArray(r.before)&&Array.isArray(r.after)&&
    r.before.every(x=>SAFE_GROUPS.has(x))&&r.after.every(x=>SAFE_GROUPS.has(x))&&
    new Set(r.before).size===r.before.length&&new Set(r.after).size===r.after.length&&
    typeof r.reason==='string'&&r.reason.length>=8&&r.reason.length<=200&&
    typeof r.time==='string'&&Number.isFinite(Date.parse(r.time))&&
    typeof r.prev==='string'&&/^(?:[a-f0-9]{64})$/.test(r.prev)&&
    typeof r.mac==='string'&&/^[a-f0-9]{64}$/.test(r.mac);
}

export class AuthorityRegistry {
  constructor(portal,{journalPath,checkpointPath,auditKey,issuer,resource,adminSubjects=[],now=()=>new Date()}={}) {
    if(!portal||typeof portal.directory!=='function'||typeof portal.mcpCall!=='function')
      throw Error('Authority registry requires an existing authenticated portal.');
    if(!isAbsolute(journalPath||'')||!isAbsolute(checkpointPath||'')||
       journalPath.toLowerCase()===checkpointPath.toLowerCase()||!/^https:\/\//.test(issuer||'')||
       !/^https:\/\//.test(resource||'')||
       !Array.isArray(adminSubjects)||adminSubjects.some(x=>typeof x!=='string'||!x||x.length>256)||
       new Set(adminSubjects).size!==adminSubjects.length||typeof now!=='function')
      throw Error('Invalid local authority configuration.');
    const key=Buffer.from(auditKey||'','base64');
    if(key.length!==32)throw Error('A 256-bit private audit MAC key is required.');
    this.portal=portal;
    this.path=journalPath;
    this.checkpointPath=checkpointPath;
    this.key=key;
    this.issuer=issuer;
    this.resource=resource;
    this.adminSubjects=new Set(adminSubjects);
    this.now=now;
    // Fail closed on corrupt audit state even for read-only probes.
    this.replay();
  }
  claimsVerified(token){return validatedClaims(token,this.issuer,this.resource,this.now);}
  replay(){
    // A missing or erased journal cannot silently remove an owner's restrictions.
    // Initial state requires explicit offline provisioning with a MAC-bound checkpoint.
    let data;
    try{data=readFileSync(this.path);}catch{fail(503,'audit_integrity_failed','Cannot read the local authority audit.');}
    if(data.length>MAX_JOURNAL||data.length&&data.at(-1)!==10)
      fail(503,'audit_integrity_failed','Local authority audit appears incomplete.');
    const states=new Map(),entries=[];
    let prev='0'.repeat(64);
    for(const line of data.toString('utf8').split('\n').filter(Boolean)){
      let e;try{e=JSON.parse(line);}catch{fail(503,'audit_integrity_failed','Local authority audit is malformed.');}
      if(!validJournalRecord(e)||e.seq!==entries.length+1||e.prev!==prev)
        fail(503,'audit_integrity_failed','Local authority audit sequence mismatch.');
      const {mac,...payload}=e;
      const expected=createHmac('sha256',this.key).update(JSON.stringify(payload)).digest('hex');
      const x=Buffer.from(expected,'hex'),y=Buffer.from(mac,'hex');
      if(x.length!==y.length||!timingSafeEqual(x,y))
        fail(503,'audit_integrity_failed','Local authority audit signature mismatch.');
      const name=e.account+'\0'+e.device;
      const cur=states.get(name)||{revision:0,denied:[]};
      if(e.revision!==cur.revision+1||JSON.stringify(e.before)!==JSON.stringify(cur.denied))
        fail(503,'audit_integrity_failed','Local authority audit history differs from prior state.');
      states.set(name,{revision:e.revision,denied:e.after});
      entries.push(e);prev=e.mac;
    }
    try{
      verifyAuditCheckpoint({journalPath:this.path,checkpointPath:this.checkpointPath,
        auditKey:this.key,journal:data,count:entries.length,head:prev});
    }catch{fail(503,'audit_integrity_failed','Audit checkpoint missing or mismatched; no authority actions allowed.');}
    return {entries,states,prev};
  }
  state(token,deviceId){
    validateDevice(deviceId);
    const actor=this.claimsVerified(token);
    const st=this.replay().states.get(actor.key+'\0'+deviceId);
    return st?{revision:st.revision,denied:clone(st.denied)}:{revision:0,denied:[]};
  }
  audit(token,deviceId){
    validateDevice(deviceId);
    const actor=this.claimsVerified(token),key=actor.key;
    return this.replay().entries.filter(x=>x.account===key&&x.device===deviceId)
      .slice(-25).map(({seq,revision,action,before,after,time,reason})=>({
        seq,revision,action,before:clone(before),after:clone(after),time,reason
      }));
  }
  async checkedActor(token,deviceId){
    validateDevice(deviceId);
    // Do not use unverified JWT claims until the real relay has authenticated
    // the bearer, checked the OAuth scope, and applied account ownership.
    const devices=await this.portal.directory(token);
    if(!Array.isArray(devices)||!devices.some(d=>d.deviceId===deviceId&&d.revokedAt===null))
      fail(403,'device_not_paired','The device is not actively paired with this account.');
    return this.claimsVerified(token);
  }
  async ownerEnrollmentProof(token,deviceId){
    // Existing relay first confirms the bearer, account, scope and pairing.
    // The local Windows administrator must separately approve this short-lived
    // HMAC-sealed proof before the owner can edit portal restrictions.
    const actor=await this.checkedActor(token,deviceId);
    const issuedAt=this.now();
    const payload={
      schema:'tetherplane.controlcenter.owner-enrollment.v1',
      issuer:this.issuer,resource:this.resource,
      subject:actor.sub,deviceId,
      issuedAt:issuedAt.toISOString(),
      expiresAt:new Date(issuedAt.getTime()+300000).toISOString(),
      nonce:randomBytes(16).toString('base64url')
    };
    const data=Buffer.from(JSON.stringify(payload),'utf8');
    const mac=createHmac('sha256',this.key)
      .update('tetherplane.owner-enrollment.v1').update(Buffer.from([0]))
      .update(data).digest();
    return {
      proof:data.toString('base64url')+'.'+mac.toString('base64url'),
      expiresAt:payload.expiresAt,deviceId
    };
  }
  async observe(token,deviceId){
    const actor=await this.checkedActor(token,deviceId);
    // Native device.capabilities reflects the agent-local bound principal.
    // It is an advertised set, not an end-to-end proof of this browser's grant.
    let result;
    try{result=await this.portal.mcpCall(token,'device','capabilities',deviceId,{});}
    catch{fail(502,'capability_discovery_unavailable','Agent capability discovery did not respond.');}
    const raw=result?.structuredContent;
    if(result?.isError===true||!obj(raw)||!Array.isArray(raw.providers)||
       raw.providers.length>30)fail(403,'capability_discovery_denied','The agent did not authorize capability discovery.');
    const seen=new Set();
    const providers=raw.providers.map(p=>{
      if(!obj(p)||typeof p.namespace!=='string'||!/^[a-z][a-z0-9_]{0,39}$/.test(p.namespace)||
        seen.has(p.namespace)||typeof p.available!=='boolean'||!Array.isArray(p.operations)||
        p.operations.length>60||p.operations.some(op=>typeof op!=='string'||
          !/^[a-z][a-z0-9_]{0,63}$/.test(op))||new Set(p.operations).size!==p.operations.length)
        fail(502,'invalid_capability_response','Invalid agent capabilities response.');
      seen.add(p.namespace);
      return {namespace:p.namespace,available:p.available,operations:clone(p.operations)};
    });
    const state=this.state(token,deviceId);
    return {
      deviceId,source:'agent_device.capabilities',observedAt:this.now().toISOString(),
      authorityScope:'control_center_only',isOwner:this.adminSubjects.has(actor.sub),
      agentPolicyModifiable:false,agentCapabilitiesAreCallerGrants:false,
      providers,effectiveAccess:effectiveInventory(providers,state.denied),...state,audit:this.audit(token,deviceId)
    };
  }
  async verifyAccess(token,deviceId,probe,path){
    const actor=await this.checkedActor(token,deviceId);
    if(!this.adminSubjects.has(actor.sub))
      fail(403,'owner_approval_required','Only the verified owner may run active access checks.');
    let spec,args;
    try{({spec,args}=checkedProbe(probe,path));}
    catch(e){fail(400,'invalid_access_probe',e.message);}
    const observed=await this.observe(token,deviceId);
    const p=observed.providers.find(x=>x.namespace===spec.namespace);
    const observedAt=this.now().toISOString();
    const base={deviceId,probe,capability:spec.namespace+'.'+spec.operation,
      scope:'this_portal_oauth_session',observedAt};
    if(!p?.available||!p.operations.includes(spec.operation))
      return {...base,access:'provider_unavailable',reason:'This operation is not advertised by the connected device.'};
    if(portalDenied(spec.namespace,observed.denied))
      return {...base,access:'portal_restricted',reason:'Control Center overlay blocks this operation.'};
    try{
      const result=await this.portal.mcpCall(token,spec.tool,spec.operation,deviceId,args);
      const access=classifyProbeReply(probe,result,probe==='filesystem_info'?path:null);
      return {...base,access,reason:access==='verified_allowed'
        ?'Only this exact operation succeeded under this authenticated portal session.'
        :access==='denied'?'This operation was denied by the execution boundary.'
        :'The response did not establish whether the operation is authorized.'};
    }catch(e){
      const denied=e?.status===403||e?.code==='permission_denied';
      return {...base,access:denied?'denied':'not_verified',
        reason:denied?'Relay or device denied this operation.':'No conclusive result; do not infer that access was granted or denied.'};
    }
  }
  async localApprovalRequest(token,deviceId,body){
    const actor=await this.checkedActor(token,deviceId);
    if(!this.adminSubjects.has(actor.sub))
      fail(403,'owner_approval_required','Only the verified owner can prepare a local permission request.');
    const observed=await this.observe(token,deviceId);
    let fields;
    try{fields=localReviewFields({...body,deviceId,providers:observed.providers});}
    catch(e){fail(400,'invalid_local_request',e.message);}
    const created=this.now();
    return {
      schema:'tetherplane.device_local_review_request.v1',
      deviceId,
      ...fields,
      ownerFingerprint:actor.key.slice(0,16),
      createdAt:created.toISOString(),
      expiresAt:new Date(created.getTime()+24*60*60*1000).toISOString(),
      requestId:randomBytes(16).toString('base64url'),
      requiresLocalOperator:true,
      remotelyApplied:false,
      cryptographicDeviceApproval:false,
      warning:'Review-only proposal. Treat as untrusted input. No permission changes until the local device operator independently approves and performs a checkpointed policy update.'
    };
  }
  write(actor,deviceId,denied,expectedRevision,reason,action){
    try{
      return withAuthorityWriterLease(this.path,()=>
        this.writeHeld(actor,deviceId,denied,expectedRevision,reason,action));
    }catch(e){
      if(e instanceof AuthorityWriterBusy)
        fail(503,'authority_writer_busy','Authority writer is busy or a stale lock requires owner review.');
      throw e;
    }
  }
  writeHeld(actor,deviceId,denied,expectedRevision,reason,action){
    validateRevision(expectedRevision);
    const run=this.replay(),key=actor.key+'\0'+deviceId;
    const old=run.states.get(key)||{revision:0,denied:[]};
    if(old.revision!==expectedRevision)
      fail(409,'revision_conflict','Policy changed; refresh before applying an update.');
    if(JSON.stringify(old.denied)===JSON.stringify(denied))
      fail(409,'no_change','This restriction is already applied.');
    const entry={
      seq:run.entries.length+1,account:actor.key,device:deviceId,revision:old.revision+1,
      action,before:old.denied,after:clone(denied),reason,time:this.now().toISOString(),prev:run.prev
    };
    entry.mac=createHmac('sha256',this.key).update(JSON.stringify(entry)).digest('hex');
    const data=Buffer.from(JSON.stringify(entry)+'\n','utf8');
    let fd;
    try{
      fd=openSync(this.path,'a',0o600);
      writeSync(fd,data,0,data.length);
      fsyncSync(fd);
    }catch{fail(503,'audit_write_failed','Policy was not confirmed; audit write failed.');}
    finally{if(fd!==undefined)try{closeSync(fd);}catch{}}
    // Seal the exact new high-water mark. A crash before sealing fails closed
    // on subsequent reads/restart instead of resetting privileges to allow.
    try{
      advanceAuditCheckpoint({journalPath:this.path,checkpointPath:this.checkpointPath,
        auditKey:this.key,count:entry.seq,head:entry.mac});
    }catch{fail(503,'audit_integrity_failed','Audit checkpoint was not durably confirmed.');}
    const confirmed=this.replay().states.get(key);
    if(!confirmed||confirmed.revision!==entry.revision||JSON.stringify(confirmed.denied)!==JSON.stringify(denied))
      fail(503,'audit_integrity_failed','Persisted restriction verification failed.');
    return {deviceId,revision:entry.revision,denied:clone(denied),authorityScope:'control_center_only',
      audit:{action,revision:entry.revision,time:entry.time,seq:entry.seq}};
  }
  async change({token,deviceId,denied,expectedRevision,confirmDeviceId,reason}){
    const actor=await this.checkedActor(token,deviceId);
    if(!this.adminSubjects.has(actor.sub))
      fail(403,'owner_approval_required','This verified account is not approved to manage Control Center restrictions.');
    if(confirmDeviceId!==deviceId)
      fail(400,'confirmation_required','Type the exact device name to confirm the change.');
    const groups=validateGroups(denied);validateReason(reason);
    return this.write(actor,deviceId,groups,expectedRevision,reason,'restrict');
  }
  async rollback({token,deviceId,expectedRevision,targetRevision,confirmDeviceId,reason}){
    const actor=await this.checkedActor(token,deviceId);
    if(!this.adminSubjects.has(actor.sub))
      fail(403,'owner_approval_required','This verified account is not approved to roll back policy.');
    if(confirmDeviceId!==deviceId)
      fail(400,'confirmation_required','Type the exact device name to confirm rollback.');
    validateRevision(targetRevision);
    validateReason(reason);
    const records=this.replay().entries.filter(e=>e.account===actor.key&&e.device===deviceId);
    const target=targetRevision===0?[]:records.find(x=>x.revision===targetRevision)?.after;
    if(!target||targetRevision>=expectedRevision)
      fail(400,'invalid_revision','Choose an earlier recorded restriction revision.');
    return this.write(actor,deviceId,clone(target),expectedRevision,reason,'rollback');
  }
  enforceVerified(token,deviceId,tool,op){
    // Caller MUST first await the existing relay directory and confirm device
    // belongs to the account. Never a standalone authorization grant.
    const state=this.state(token,deviceId);
    if(!state.denied.length)return true;
    const group=toolGroup[tool];
    if(group==='device'&&['status','capabilities'].includes(op))return true;
    if(!group||group==='device'||state.denied.includes(group)||group==='batch'||group==='process'||
      (state.denied.includes('filesystem')&&group==='browser')){
      fail(403,'portal_authority_denied','This Control Center has restricted that device operation.');
    }
    return true;
  }
}
