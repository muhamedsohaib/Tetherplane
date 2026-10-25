import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

if(process.platform!=='win32'){
  test('local PowerShell approval check requires Windows', {skip:true},()=>{});
}else{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const script=join(root,'scripts','Approve-TetherplaneDevicePermission.ps1');
  const dir=mkdtempSync(join(tmpdir(),'TetherplaneDevicePolicyQA-'));
  const approved=join(dir,'approved');
  mkdirSync(approved);
  const profile=join(dir,'principal.json');
  const request=join(dir,'request.json');
  const hash=()=>createHash('sha256').update(readFileSync(profile)).digest('hex');
  const profileJSON={principal_id:'synthetic:approval-test',authentication:'local_process_binding',
    allowed_devices:['RTX'],allowed_capabilities:['device.status','filesystem.info'],
    allowed_directories:[approved]};
  const now=new Date();
  const requestJSON={
    schema:'tetherplane.device_local_review_request.v1',
    deviceId:'RTX',intent:'grant',capability:'filesystem.read',directory:approved,
    reason:'Synthetic isolated device-local test',requestId:'synthetic',
    createdAt:now.toISOString(),expiresAt:new Date(now.getTime()+3600_000).toISOString(),
    ownerFingerprint:'test-only',requiresLocalOperator:true,
    remotelyApplied:false,cryptographicDeviceApproval:false
  };
  const reset=()=>{writeFileSync(profile,JSON.stringify(profileJSON));
    writeFileSync(request,JSON.stringify(requestJSON));};
  const invoke=(params=[])=>spawnSync('powershell.exe',[
    '-NoProfile','-ExecutionPolicy','Bypass','-File',script,
    '-RequestPath',request,'-PrincipalPath',profile,...params
  ],{encoding:'utf8',input:'',timeout:15000,windowsHide:true});
  test.after(()=>rmSync(dir,{recursive:true,force:true}));
  test('PowerShell 5.1 parser accepts the local operator script',()=>{
    const literal="\'"+script.replaceAll("\'","\'\'")+"\'";
    const ast="$x=$null;$y=$null;[void][System.Management.Automation.Language.Parser]::ParseFile("+literal+",[ref]$x,[ref]$y);if(@($y).Count){exit 1}";
    execFileSync('powershell.exe',['-NoProfile','-Command',ast],{timeout:15000,windowsHide:true});
  });
  test('read-only inspection accepts existing scoped filesystem root without changing bytes',()=>{
    reset();const before=hash();
    const r=invoke(['-Mode','Inspect']);
    assert.equal(r.status,0,r.stderr);
    assert.match(r.stdout,/DEVICE_LOCAL_INSPECTION=PASS/);
    assert.match(r.stdout,/NO_PERMISSION_CHANGE=YES/);
    assert.equal(hash(),before);
  });
  test('filesystem root expansion is correctly blocked before a capability edit',()=>{
    reset();const before=hash();
    const outside=join(dir,'outside');mkdirSync(outside);
    writeFileSync(request,JSON.stringify({...requestJSON,directory:outside}));
    const r=invoke(['-Mode','Inspect']);
    assert.notEqual(r.status,0);
    assert.match(r.stderr,/outside existing principal roots/i);
    assert.equal(hash(),before);
  });
  test('incorrect target device and expired proposal cannot be applied',()=>{
    reset();const before=hash();
    writeFileSync(request,JSON.stringify({...requestJSON,deviceId:'Leno'}));
    assert.notEqual(invoke(['-Mode','Inspect']).status,0);
    writeFileSync(request,JSON.stringify({...requestJSON,expiresAt:'2025-01-01T00:00:00.000Z'}));
    assert.notEqual(invoke(['-Mode','Inspect']).status,0);
    assert.equal(hash(),before);
  });
  test('remote/noninteractive Apply fails before touching the protected principal',()=>{
    reset();const before=hash();
    const r=invoke(['-Mode','Apply','-ExpectedPrincipalSha256',before]);
    assert.notEqual(r.status,0);
    assert.equal(hash(),before);
    assert.doesNotMatch(r.stdout,/LOCAL_PRINCIPAL_FILE_UPDATED=YES/);
  });
  test('Restore requires a real verified recovery receipt, not an arbitrary file',()=>{
    reset();const before=hash();
    const receipt=join(dir,'fake-receipt.json');
    writeFileSync(receipt,JSON.stringify({schema:'untrusted',deviceId:'RTX'}));
    const r=invoke(['-Mode','Restore','-ReceiptPath',receipt]);
    assert.notEqual(r.status,0);
    assert.equal(hash(),before);
  });
}
