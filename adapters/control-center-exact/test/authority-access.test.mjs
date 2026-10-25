import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveInventory,portalDenied,checkedProbe,classifyProbeReply,localReviewFields
} from '../authority-access.mjs';

const providers=[
  {namespace:'device',available:true,operations:['status','capabilities']},
  {namespace:'filesystem',available:true,operations:['read','info']},
  {namespace:'process',available:true,operations:['run']},
  {namespace:'desktop',available:true,operations:[]},
  {namespace:'browser',available:false,operations:[]},
  {namespace:'batch',available:true,operations:['execute']}
];
test('advertised support NEVER claims an OAuth grant without an independent probe',()=>{
  const inv=effectiveInventory(providers,[]);
  assert.equal(inv.find(x=>x.namespace==='filesystem').access,'not_verified');
  assert.equal(inv.find(x=>x.namespace==='process').access,'not_verified');
  assert.equal(inv.find(x=>x.namespace==='desktop').access,'no_operations_advertised');
  assert.equal(inv.find(x=>x.namespace==='browser').access,'provider_unavailable');
  assert.ok(inv.every(x=>x.evidence==='advertised_inventory_only'));
});
test('portal restrictions are shown as restrictions and process/batch collateral blocks are disclosed',()=>{
  assert.equal(portalDenied('process',['filesystem']),true);
  assert.equal(portalDenied('batch',['browser']),true);
  assert.equal(portalDenied('browser',['filesystem']),true);
  assert.equal(portalDenied('device',['filesystem']),false);
  assert.equal(effectiveInventory(providers,['filesystem']).find(x=>x.namespace==='process').access,'portal_restricted');
});
test('read-only access checks are exact operation specific and reject unsafe or implicit paths',()=>{
  assert.equal(checkedProbe('device_status').spec.operation,'status');
  assert.deepEqual(checkedProbe('process_echo').args.args,['/d','/c','echo TETHERPLANE_PORTAL_ACCESS_PROBE']);
  assert.equal(checkedProbe('filesystem_info','D:\\Work\\project\\report.txt').args.path,'D:\\Work\\project\\report.txt');
  for(const path of ['.', '..\\secrets','C:\\..\\keys','C:\\','\\\\server\\share','C:\\folder\\..\\secret']){
    assert.throws(()=>checkedProbe('filesystem_info',path));
  }
  assert.throws(()=>checkedProbe('desktop_snapshot'));
  assert.throws(()=>checkedProbe('device_status','C:\\x'));
});
test('only a successful exact tool result earns verified_allowed',()=>{
  assert.equal(classifyProbeReply('device_status',{isError:false,structuredContent:{agent_version:'0.1.0',policy_mode:'background_only'}}),'verified_allowed');
  assert.equal(classifyProbeReply('device_status',{isError:false,structuredContent:{ok:true}}),'not_verified');
  assert.equal(classifyProbeReply('filesystem_info',{isError:true,structuredContent:{error:{code:'permission_denied'}}}),'denied');
  assert.equal(classifyProbeReply('filesystem_info',{isError:true,structuredContent:{error:{code:'internal_error'}}}),'not_verified');
  const requested='D:\\Work\\approved\\report.txt';
  const validInfo={isError:false,structuredContent:{
    path:requested,type:'file',size:123,modified_unix_ms:1792000000000}};
  assert.equal(classifyProbeReply('filesystem_info',validInfo,requested),'verified_allowed');
  assert.equal(classifyProbeReply('filesystem_info',validInfo,'D:\\Work\\private\\report.txt'),'not_verified',
    'success on a different path must never be mistaken for a grant');
  assert.equal(classifyProbeReply('filesystem_info',{isError:false,structuredContent:{}},requested),'not_verified',
    'empty MCP reply is not permission evidence');
  assert.equal(classifyProbeReply('browser_status',{isError:false,structuredContent:{available:true,mode:'background_only'} }),'verified_allowed');
  assert.equal(classifyProbeReply('browser_status',{isError:false,structuredContent:{available:false,mode:'background_only'}}),'provider_unavailable');
  assert.equal(classifyProbeReply('browser_status',{isError:false,structuredContent:{ok:true}}),'not_verified');
  assert.equal(classifyProbeReply('process_echo',{isError:false,structuredContent:{exit_code:0,stdout:'TETHERPLANE_PORTAL_ACCESS_PROBE\r\n'}}),'verified_allowed');
  assert.equal(classifyProbeReply('process_echo',{isError:false,structuredContent:{exit_code:1,stdout:''}}),'not_verified');
});
test('device-local request is only a narrowly scoped operator proposal',()=>{
  const args={intent:'grant',capability:'filesystem.info',directory:'D:\\Work\\specific-folder',
    reason:'Allow inspection of approved workspace',confirmDeviceId:'RTX',deviceId:'RTX',providers};
  const r=localReviewFields(args);
  assert.equal(r.directory,'D:\\Work\\specific-folder');
  assert.equal(r.capability,'filesystem.info');
  for(const dir of ['D:\\','D:\\..\\Windows','D:\\Work\\..\\Private','\\\\server\\share']){
    assert.throws(()=>localReviewFields({...args,directory:dir}));
  }
  assert.throws(()=>localReviewFields({...args,capability:'device.shutdown'}));
  assert.throws(()=>localReviewFields({...args,capability:'browser.status'}));
  assert.throws(()=>localReviewFields({...args,confirmDeviceId:'Leno'}));
  assert.throws(()=>localReviewFields({...args,reason:'short'}));
  assert.deepEqual(localReviewFields({...args,intent:'revoke',capability:'process.run',directory:''}),
    {intent:'revoke',capability:'process.run',directory:null,reason:args.reason,advertisedByAgent:true});
  assert.equal(localReviewFields({...args,capability:'desktop.snapshot',directory:''}).advertisedByAgent,false);
});
