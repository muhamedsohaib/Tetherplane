/* Device Authority: appended UI only; original ASCII, animation and themes untouched. */
(() => {
'use strict';
const GROUPS=['filesystem','process','browser','desktop','batch'];
const CSS=[
'#tp-authority-modal[hidden]{display:none!important}',
'#tp-authority-modal{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.75);padding:16px}',
'#tp-authority-panel{width:min(850px,100%);max-height:90vh;overflow:auto;padding:22px;background:rgba(12,12,12,.98);color:#eee;border:1px solid #777;border-radius:18px}',
'body.ivory-mode #tp-authority-panel{background:rgba(250,250,250,.98);color:#151515}',
'body.ivory-mode #tp-authority-modal{background:rgba(90,90,90,.55)}',
'#tp-authority-panel *{box-sizing:border-box}',
'.tp-auth-section{border-top:1px solid #7775;padding-top:12px;margin-top:14px}',
'.tp-auth-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}',
'.tp-auth-card{padding:12px;border:1px solid #8886;border-radius:12px}',
'.tp-auth-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(195px,1fr));gap:10px}',
'.tp-auth-note{font-size:11px;line-height:1.55;opacity:.75}',
'.tp-auth-input{border:1px solid #7779;border-radius:9px;padding:9px;color:inherit;background:transparent;width:100%;font:inherit}',
'#tp-authority-panel button:disabled,#tp-authority-panel input:disabled{opacity:.45;cursor:not-allowed}',
'#tp-authority-panel [aria-pressed=true]{outline:2px solid currentColor}'
].join('\n');
const $=id=>document.getElementById(id);
const state={csrf:'',devices:[],current:null,selected:'',busy:false,requestEpoch:0};
function el(tag,cls,text,parent){
 const x=document.createElement(tag);if(cls)x.className=cls;
 if(text!==undefined&&text!==null)x.textContent=String(text);
 if(parent)parent.append(x);return x;
}
function btn(label,parent,fn,id){
 const x=el('button','mono-btn rounded-xl px-3 py-2 text-xs',label,parent);
 x.type='button';if(id)x.id=id;x.addEventListener('click',fn);return x;
}
function note(label,parent){return el('p','tp-auth-note',label,parent);}
function info(message,failed=false){const x=$('tp-authority-message');if(x){x.textContent=message;x.style.color=failed?'#d97575':'';}}
async function api(path,method='GET',body){
 const headers={accept:'application/json'};
 if(method==='POST'){headers['content-type']='application/json';headers['x-csrf-token']=state.csrf;}
 const result=await fetch(path,{
  method,headers,credentials:'same-origin',cache:'no-store',redirect:'error',mode:'same-origin',
  signal:AbortSignal.timeout(14000),
  ...(method==='POST'?{body:JSON.stringify(body)}:{})
 });
 if(!(result.headers.get('content-type')||'').startsWith('application/json'))throw Error('Unexpected API response');
 const payload=await result.json();
 if(!result.ok)throw Error(String(payload?.error?.message||'Request rejected').slice(0,180));
 return payload;
}
function allowInput(){
 const enabled=state.current?.isOwner===true&&!state.busy;
 const proofButton=$('tp-authority-copy-owner-proof');
 if(proofButton)proofButton.disabled=!state.current||state.busy;
 for(const id of ['tp-authority-confirm','tp-authority-reason','tp-authority-apply',
   'tp-authority-rollback','tp-authority-target-revision',...GROUPS.map(x=>'tp-authority-deny-'+x)]){
  if($(id))$(id).disabled=!enabled;
 }
}
function showDevices(){
 const box=$('tp-authority-device-list');box.replaceChildren();
 for(const d of state.devices){
  const x=btn(d.deviceId,box,()=>{void select(d.deviceId);});
  x.dataset.authorityDevice=d.deviceId;
  x.setAttribute('aria-pressed',String(d.deviceId===state.selected));
 }
}
function draw(){
 const d=state.current;if(!d)return;
 $('tp-authority-device-title').textContent=d.deviceId;
 $('tp-authority-revision').textContent='Revision '+d.revision;
 $('tp-authority-source').textContent='Source: '+d.source+' · '+d.observedAt;
 $('tp-authority-boundary').textContent='This is a Control Center tool restriction, not a device-local policy edit or an authorization grant. Device and relay policy retain final authority.';
 $('tp-authority-owner').textContent=d.isOwner?'Verified OAuth subject approved as portal policy editor':'Read-only: this OAuth subject is not approved as a portal policy editor';
 $('tp-authority-effective').textContent=d.denied.length?'Restricted: '+d.denied.join(', '):'No additional portal restrictions';
 const grid=$('tp-authority-capabilities');grid.replaceChildren();
 for(const p of d.providers){
  const card=el('div','tp-auth-card',null,grid);
  el('div','text-sm font-bold',p.namespace,card);
  note((p.available?'Advertised':'Unavailable')+' · '+p.operations.length+' operations',card);
  note(p.operations.join(' · ')||'No operations advertised',card);
 }
 for(const g of GROUPS)$('tp-authority-deny-'+g).checked=d.denied.includes(g);
 $('tp-authority-reason').value='';$('tp-authority-confirm').value='';
 const proofField=$('tp-authority-proof');if(proofField){proofField.hidden=true;proofField.value='';}
 const roll=$('tp-authority-target-revision');roll.replaceChildren();
 for(const v of [{revision:0,action:'initial'},...d.audit]){
  if(v.revision>=d.revision)continue;
  const opt=el('option',null,'Revision '+v.revision+' · '+v.action,roll);
  opt.value=String(v.revision);
 }
 const audit=$('tp-authority-audit');audit.replaceChildren();
 if(!d.audit.length)note('No authority changes recorded for this device and account.',audit);
 else for(const v of [...d.audit].reverse()){
  const row=el('div','tp-auth-card',null,audit);
  el('div','text-sm font-bold','Rev '+v.revision+' · '+v.action,row);
  note(v.time+' · '+v.reason,row);
  note('Restricted: '+(v.after.join(', ')||'none'),row);
 }
 allowInput();
}
async function select(deviceId){
 if(!state.devices.some(d=>d.deviceId===deviceId))return;
 const requestEpoch=++state.requestEpoch;
 state.selected=deviceId;state.current=null;showDevices();
 info('Verifying actual device.capabilities for '+deviceId+'…');
 state.busy=true;allowInput();$('tp-authority-capabilities').replaceChildren();
 try{
  const d=await api('/api/authority/'+encodeURIComponent(deviceId));
  // A previous request must never overwrite the authority of a newer selection.
  if(requestEpoch!==state.requestEpoch||$('tp-authority-modal').hidden)return;
  if(d.deviceId!==deviceId||d.authorityScope!=='control_center_only'||!Array.isArray(d.providers))
   throw Error('Invalid authority observation');
  state.current=d;draw();info('Live device capability discovery complete. Agent policy remains final.');
 }catch(e){
  if(requestEpoch===state.requestEpoch&&!$('tp-authority-modal').hidden)
   info('Authority unavailable: '+e.message,true);
 }finally{
  if(requestEpoch===state.requestEpoch){state.busy=false;allowInput();}
 }
}
async function open(){
 if(state.busy)return;
 const requestEpoch=++state.requestEpoch;
 $('tp-authority-modal').hidden=false;info('Loading authenticated account directory…');state.busy=true;
 try{
  const [session,directory]=await Promise.all([api('/api/session'),api('/api/devices')]);
  if(requestEpoch!==state.requestEpoch||$('tp-authority-modal').hidden)return;
  if(!session.authenticated||typeof session.csrfToken!=='string'||!Array.isArray(directory.devices))
   throw Error('An authenticated portal session is required');
  state.csrf=session.csrfToken;
  state.devices=directory.devices.filter(d=>typeof d.deviceId==='string'&&d.revokedAt===null);
  showDevices();state.busy=false;
  if(state.devices.length)await select(state.devices.some(d=>d.deviceId===state.selected)?state.selected:state.devices[0].deviceId);
  else info('No active paired devices.',true);
 }catch(e){
  if(requestEpoch===state.requestEpoch&&!$('tp-authority-modal').hidden)
   info('Unable to load authority: '+e.message,true);
 }finally{
  if(requestEpoch===state.requestEpoch){state.busy=false;allowInput();}
 }
}
function close(){
 const proof=$('tp-authority-proof');if(proof){proof.value='';proof.hidden=true;}
 ++state.requestEpoch;
 $('tp-authority-modal').hidden=true;state.current=null;state.csrf='';state.busy=false;
}
async function copyOwnerProof(){
 const d=state.current;if(!d||state.busy)return;
 state.busy=true;allowInput();info('Verifying your existing OAuth account through the relay...');
 try{
  const r=await api('/api/authority/'+encodeURIComponent(d.deviceId)+'/owner-proof');
  if(typeof r.proof!=='string'||!(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).test(r.proof))
   throw Error('Malformed identity proof');
  const field=$('tp-authority-proof');
  field.value=r.proof;field.hidden=false;
  try{
   if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');
   await navigator.clipboard.writeText(r.proof);
   info('Verified owner proof copied. Paste ONLY into the elevated VAULTER enrollment prompt within 5 minutes.');
  }catch{
   field.focus();field.select();
   info('Owner proof ready below. Press Ctrl+C to copy, then paste ONLY into the elevated VAULTER enrollment prompt within 5 minutes.');
  }
 }catch(e){info('Unable to prepare verified owner proof: '+e.message,true);}
 finally{state.busy=false;allowInput();}
}
async function apply(action){
 const d=state.current;if(!d||!d.isOwner||state.busy)return;
 const confirmDeviceId=$('tp-authority-confirm').value;
 const reason=$('tp-authority-reason').value.trim();
 if(confirmDeviceId!==d.deviceId||reason.length<8||reason.length>200){
  info('Enter the exact device name and a specific reason (8–200 characters).',true);return;
 }
 const expectedRevision=d.revision;
 let body;
 if(action==='change'){
  const denied=GROUPS.filter(g=>$('tp-authority-deny-'+g).checked);
  if(JSON.stringify(denied)===JSON.stringify(d.denied)){info('No change selected.',true);return;}
  body={denied,expectedRevision,confirmDeviceId,reason};
 }else{
  const targetRevision=Number($('tp-authority-target-revision').value);
  if(!Number.isInteger(targetRevision)||targetRevision>=expectedRevision){
   info('Select an earlier recorded revision.',true);return;
  }
  body={targetRevision,expectedRevision,confirmDeviceId,reason};
 }
 state.busy=true;allowInput();info('Submitting explicit authenticated '+action+'…');
 try{
  const r=await api('/api/authority/'+encodeURIComponent(d.deviceId)+'/'+action,'POST',body);
  if(r.revision!==expectedRevision+1)throw Error('Receipt could not be verified');
  state.busy=false;await select(d.deviceId);
  info('Confirmed '+action+' at revision '+r.revision+'.');
 }catch(e){info('Change not confirmed: '+e.message+'. Refresh before retry.',true);}
 finally{state.busy=false;allowInput();}
}
function install(){
 const card=document.querySelectorAll('article.card-slot')[2];
 if(!card||$('tp-authority-open'))return;
 const style=el('style',null,CSS,document.head);style.id='tp-authority-style';
 const launch=btn('[ Device Authority ]',card,()=>{void open();},'tp-authority-open');
 launch.style.width='100%';launch.style.marginTop='10px';
 const modal=el('div',null,null,document.body);modal.id='tp-authority-modal';modal.hidden=true;
 modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');
 modal.setAttribute('aria-label','Tetherplane Device Authority');
 modal.addEventListener('click',e=>{if(e.target===modal)close();});
 const panel=el('section','mono-glass rounded-2xl',null,modal);panel.id='tp-authority-panel';
 const head=el('div','tp-auth-row',null,panel);head.style.justifyContent='space-between';
 el('h2','text-lg font-bold','[ Device Authority ]',head);
 btn('[ Close ]',head,close,'tp-authority-close');
 note('Live capability discovery · Explicit account authorization · Audited restrictions · Rollback',panel);
 el('div','tp-auth-section tp-auth-row',null,panel).id='tp-authority-device-list';
 const details=el('div','tp-auth-section',null,panel);
 el('h3','text-xs font-bold','DEVICE AUTHORITY',details);
 el('h4','text-lg font-bold','Select a paired device',details).id='tp-authority-device-title';
 el('p','text-xs','Revision —',details).id='tp-authority-revision';
 note('Not queried',details).id='tp-authority-source';
 note('Device-local policy remains final.',details).id='tp-authority-boundary';
 const message=note('',panel);message.id='tp-authority-message';message.setAttribute('role','status');
 const discovery=el('div','tp-auth-section',null,panel);
 el('h3','text-sm font-bold','LIVE AGENT CAPABILITIES',discovery);
 el('div','tp-auth-grid',null,discovery).id='tp-authority-capabilities';
 const control=el('div','tp-auth-section',null,panel);
 el('h3','text-sm font-bold','CONTROL CENTER RESTRICTIONS',control);
 note('Checked groups are blocked through this portal only. While any restriction is active, process and batch calls are blocked to reduce bypasses.',control);
 el('div','text-xs font-bold','Not yet observed',control).id='tp-authority-effective';
 el('div','tp-auth-note',null,control).id='tp-authority-owner';
 const group=el('div','tp-auth-grid',null,control);
 for(const g of GROUPS){
  const label=el('label','tp-auth-card',null,group);
  const box=el('input',null,null,label);box.type='checkbox';box.id='tp-authority-deny-'+g;
  box.disabled=true;box.style.marginRight='8px';label.append(document.createTextNode('Restrict '+g));
 }
 note('These controls cannot grant device-local privileges or bypass the authenticated agent.',control);
 const update=el('div','tp-auth-section',null,panel);
 note('To enable restriction editing for this OAuth account, export a short-lived verified identity proof for the protected local administrator. This does not grant device capabilities.',update);
 btn('[ Copy Verified Owner Proof ]',update,()=>{void copyOwnerProof();},'tp-authority-copy-owner-proof');
 const proofField=el('input','tp-auth-input',null,update);proofField.id='tp-authority-proof';proofField.hidden=true;proofField.readOnly=true;proofField.setAttribute('aria-label','Verified identity proof for VAULTER administrator only');
 el('h3','text-sm font-bold','EXPLICIT OWNER CONFIRMATION',update);
 note('Enter the exact device ID and a reason. Never include passwords, credentials or access tokens.',update);
 const inputs=el('div','tp-auth-grid',null,update);
 const one=el('label','tp-auth-note','Confirm exact device ID',inputs);
 el('input','tp-auth-input',null,one).id='tp-authority-confirm';
 const two=el('label','tp-auth-note','Reason',inputs);
 el('input','tp-auth-input',null,two).id='tp-authority-reason';
 const actions=el('div','tp-auth-row',null,update);actions.style.marginTop='12px';
 btn('[ Apply Restrictions ]',actions,()=>{void apply('change');},'tp-authority-apply');
 const selectRev=el('select','tp-auth-input',null,actions);
 selectRev.id='tp-authority-target-revision';selectRev.style.width='auto';
 btn('[ Roll Back Revision ]',actions,()=>{void apply('rollback');},'tp-authority-rollback');
 const audit=el('div','tp-auth-section',null,panel);
 el('h3','text-sm font-bold','AUDIT HISTORY',audit);
 el('div','tp-auth-grid',null,audit).id='tp-authority-audit';
 modal.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
 allowInput();
}
window.addEventListener('load',install);
})();
