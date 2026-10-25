// Private, explicit one-time provisioning and a durable audit high-water checkpoint.
// These records only govern Control Center restrictions, never the agent's policy.
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {
  existsSync,readFileSync,openSync,writeSync,fsyncSync,closeSync,renameSync,unlinkSync
} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';

const ZERO='0'.repeat(64);
const HEX=/^[a-f0-9]{64}$/;
const MAX_CHECKPOINT=2048;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const validPath=x=>typeof x==='string'&&isAbsolute(x);
const safeEqual=(x,y)=>{
  const a=Buffer.from(x,'hex'),b=Buffer.from(y,'hex');
  return a.length===b.length&&timingSafeEqual(a,b);
};
function validatePaths(journalPath,checkpointPath){
  if(!validPath(journalPath)||!validPath(checkpointPath)||
      resolve(journalPath).toLowerCase()===resolve(checkpointPath).toLowerCase())
    throw Error('Separate absolute journalPath and checkpointPath are required.');
}
function keyBytes(auditKey){
  const key=Buffer.isBuffer(auditKey)?auditKey:Buffer.from(auditKey||'','base64');
  if(key.length!==32)throw Error('An existing private 256-bit audit key is required.');
  return key;
}
function checkpoint(journal,count,head,key){
  if(!Number.isSafeInteger(count)||count<0||!HEX.test(head))
    throw Error('Invalid audit checkpoint inputs.');
  const record={version:1,count,head,digest:sha(journal)};
  const mac=createHmac('sha256',key)
    .update('tetherplane-authority-checkpoint-v1\n'+JSON.stringify(record))
    .digest('hex');
  return {...record,mac};
}
function writeFully(fd,data){
  let written=0;
  while(written<data.length){
    const size=writeSync(fd,data,written,data.length-written);
    if(!Number.isSafeInteger(size)||size<=0)throw Error('Audit checkpoint write incomplete.');
    written+=size;
  }
}
function readAndVerify(checkpointPath,expected,key){
  const bytes=readFileSync(checkpointPath);
  if(!bytes.length||bytes.length>MAX_CHECKPOINT)throw Error('Invalid checkpoint size.');
  const parsed=JSON.parse(bytes.toString('utf8'));
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||
      Object.keys(parsed).sort().join(',')!=='count,digest,head,mac,version'||
      parsed.version!==1||!Number.isSafeInteger(parsed.count)||parsed.count<0||
      typeof parsed.head!=='string'||!HEX.test(parsed.head)||
      typeof parsed.digest!=='string'||!HEX.test(parsed.digest)||
      typeof parsed.mac!=='string'||!HEX.test(parsed.mac))
    throw Error('Invalid checkpoint format.');
  const {mac,...data}=parsed;
  const expectedMac=createHmac('sha256',key)
    .update('tetherplane-authority-checkpoint-v1\n'+JSON.stringify(data))
    .digest('hex');
  if(!safeEqual(mac,expectedMac)||
      parsed.count!==expected.count||parsed.head!==expected.head||
      parsed.digest!==expected.digest)throw Error('Audit checkpoint history mismatch.');
  return true;
}
export function verifyAuditCheckpoint({journalPath,checkpointPath,auditKey,journal,count,head}){
  validatePaths(journalPath,checkpointPath);
  const key=keyBytes(auditKey);
  const expected=checkpoint(journal,count,head,key);
  return readAndVerify(checkpointPath,expected,key);
}
export function provisionAuthorityAudit({journalPath,checkpointPath,auditKey}){
  validatePaths(journalPath,checkpointPath);
  const key=keyBytes(auditKey);
  // Never bootstrap over even one existing file: partial init requires review.
  if(existsSync(journalPath)||existsSync(checkpointPath))
    throw Error('Audit storage already exists or was partially provisioned. No overwrite.');
  let fd;
  try{
    fd=openSync(journalPath,'wx',0o600);
    fsyncSync(fd);
  }finally{if(fd!==undefined)closeSync(fd);}
  try{
    const data=Buffer.from(JSON.stringify(checkpoint(Buffer.alloc(0),0,ZERO,key))+'\n');
    fd=undefined;
    fd=openSync(checkpointPath,'wx',0o600);
    writeFully(fd,data);
    fsyncSync(fd);
  }finally{if(fd!==undefined)closeSync(fd);}
  return true;
}
export function advanceAuditCheckpoint({journalPath,checkpointPath,auditKey,count,head}){
  validatePaths(journalPath,checkpointPath);
  const key=keyBytes(auditKey);
  // Replacing a vanished checkpoint would silently reset a security boundary.
  if(!existsSync(checkpointPath))throw Error('Audit checkpoint is missing.');
  const journal=readFileSync(journalPath);
  const data=Buffer.from(JSON.stringify(checkpoint(journal,count,head,key))+'\n');
  const temporary=checkpointPath+'.pending-'+randomBytes(12).toString('hex');
  let fd;
  try{
    fd=openSync(temporary,'wx',0o600);
    writeFully(fd,data);fsyncSync(fd);
    closeSync(fd);fd=undefined;
    if(!existsSync(checkpointPath))throw Error('Audit checkpoint vanished during update.');
    renameSync(temporary,checkpointPath);
  }finally{
    if(fd!==undefined)try{closeSync(fd);}catch{}
    // This is only our own generated temporary file, never owner state.
    if(existsSync(temporary))try{unlinkSync(temporary);}catch{}
  }
  return true;
}

export class AuthorityWriterBusy extends Error {
  constructor(){super('Another Control Center authority writer is active or a stale lock requires owner review.');}
}
// Lock acquisition is exclusive across local processes, and precedes replay+append+checkpoint.
// A stale lock is never removed automatically after an unclean shutdown.
export function withAuthorityWriterLease(journalPath,writeAction){
  if(!validPath(journalPath)||typeof writeAction!=='function')
    throw Error('Invalid authority writer lease parameters.');
  const lockPath=journalPath+'.writer.lock';
  let fd;
  try{fd=openSync(lockPath,'wx',0o600);}
  catch(e){
    if(e?.code==='EEXIST')throw new AuthorityWriterBusy();
    throw e;
  }
  try {
    // An empty existing lockfile is sufficient for atomic exclusive-create.
    // There is deliberately no PID-based force-unlock or time-based stale cleanup.
    fsyncSync(fd);
    return writeAction();
  } finally {
    try{closeSync(fd);}
    finally{unlinkSync(lockPath);}
  }
}
