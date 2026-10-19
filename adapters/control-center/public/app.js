import {mountAsciiLoader} from './ascii-cycle.js';

const $ = id=>document.getElementById(id);
const VIEWS=['home','devices','access','pairing','settings'];
const loader=mountAsciiLoader({root:$('loading'),base:$('loading-base'),overlay:$('loading-overlay'),pauseButton:$('pause-motion')});
let csrf=null, generation=0, pending=null, expiryTimer=null, selectedDevice=null;
let authenticated=false, busy=false, directoryFresh=false, currentView='home', directory=[];

function message(text){$('notice').textContent=text;$('notice').hidden=!text;}
function formattedDate(value){const d=new Date(value);return Number.isNaN(d.getTime())?'Not reported':new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(d);}
function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function clearDirectory(){
 directoryFresh=false;directory=[];
 $('devices').replaceChildren();$('access-records').replaceChildren();$('empty').hidden=true;
 $('home-count').textContent='—';$('home-refreshed').textContent='Not yet refreshed';
 $('device-count').textContent='—';$('observed-at').textContent='Not yet refreshed';
 updatePairButton();
}
function setBusy(value,label='Loading…'){
 busy=value;
 if(value)loader.show(label);else loader.hide();
 for(const id of ['signin-button','refresh','pair-code','pair-owned','cancel-revoke'])$(id).disabled=value;
 updatePairButton();
 updateRevokeButton();
 $('dashboard').setAttribute('aria-busy',String(value));
}
function closeNavigation(){const nav=$('main-nav');nav.dataset.open='false';$('mobile-nav-toggle').setAttribute('aria-expanded','false');}
export function renderView(view){
 if(!authenticated||!VIEWS.includes(view))return;
 currentView=view;
 for(const name of VIEWS){const screen=$(`view-${name}`);if(screen)screen.hidden=name!==view;}
 for(const button of document.querySelectorAll('#main-nav [data-view]')){
  if(button.dataset.view===view)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
 }
 closeNavigation();
}
function signedOut(){
 clearTimeout(expiryTimer);expiryTimer=null;
 authenticated=false;csrf=null;selectedDevice=null;
 $('credential').value='';$('pair-code').value='';$('pair-owned').checked=false;$('confirmation').value='';
 if($('revoke-dialog').open)$('revoke-dialog').close();
 clearDirectory();$('dashboard').hidden=true;$('welcome').hidden=false;
 $('main-nav').hidden=true;$('mobile-nav-toggle').hidden=true;
 $('header-status').textContent='LOCAL CONTROL CENTER';
 currentView='home';setBusy(false);
}
function updatePairButton(){
 $('approve-pair').disabled=busy||!csrf||!directoryFresh||!$('pair-owned').checked||!/^[A-F0-9]{4}-[A-F0-9]{4}$/.test($('pair-code').value.trim().toUpperCase());
}
function updateRevokeButton(){
 $('confirm-revoke').disabled=busy||!selectedDevice||$('confirmation').value!==selectedDevice;
}
async function api(path,signal,options={}){
 let response;
 try{
  response=await fetch(path,{
   method:options.method??'GET',signal,credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',
   headers:{...(options.method==='POST'?{'content-type':'application/json'}:{}),...(csrf?{'x-csrf-token':csrf}:{})},
   ...(options.body===undefined?{}:{body:JSON.stringify(options.body)})
  });
 }catch(error){if(signal?.aborted)throw error;throw new Error('The local service could not be reached. Check that Control Center is running, then refresh.');}
 let data;
 try{data=await response.json();}catch{throw new Error('The service returned an unsupported response. Refresh before trying again.');}
 if(!response.ok){const error=new Error(data.error?.message??'The request could not be completed. Refresh before trying again.');error.status=response.status;throw error;}
 return data;
}
async function run(task,label,onSuccess,quiet401=false){
 const current=++generation;
 pending?.abort();pending=new AbortController();
 const signal=AbortSignal.any([pending.signal,AbortSignal.timeout(8000)]);
 message('');setBusy(true,label);
 try{const data=await task(signal);if(current===generation)onSuccess(data);}
 catch(error){
  if(current!==generation)return;
  const denied=error.status===401;
  $('pair-code').value='';$('pair-owned').checked=false;
  selectedDevice=null;
  if($('revoke-dialog').open)$('revoke-dialog').close();
  clearDirectory();
  if(denied)signedOut();
  if(!(quiet401&&denied))message(error.name==='TimeoutError'||signal.aborted?'The request timed out. Its result is uncertain; refresh before trying any action again.':error.message);
 }finally{if(current===generation){pending=null;setBusy(false);}}
}
function openRevoke(deviceId){
 if(!authenticated||busy)return;
 selectedDevice=deviceId;
 $('revoke-device').textContent=deviceId;
 $('confirmation').value='';updateRevokeButton();
 $('revoke-dialog').showModal();$('confirmation').focus();
}
function deviceCard(device,canRevoke){
 const card=element('article','device-card');
 const identity=element('div','device-identity');
 identity.append(element('h2','',device.deviceId),element('span','badge',device.revokedAt?'Revoked':'Paired'));
 const details=element('dl');
 const fields=[['Connectivity','Connectivity not reported'],['Agent version','Not reported'],['Paired',formattedDate(device.pairedAt)],...(device.revokedAt?[['Revoked',formattedDate(device.revokedAt)]]:[])];
 for(const [title,value] of fields)details.append(element('dt','',title),element('dd','',value));
 card.append(identity,details);
 if(canRevoke&&!device.revokedAt){const button=element('button','button-outline','Revoke access');button.type='button';button.addEventListener('click',()=>openRevoke(device.deviceId));card.append(button);}
 else if(device.revokedAt)card.append(element('p','muted-small','Fresh authorized pairing required'));
 return card;
}
function renderDirectory(){
 $('devices').replaceChildren(...directory.map(d=>deviceCard(d,false)));
 $('access-records').replaceChildren(...directory.map(d=>deviceCard(d,true)));
 $('empty').hidden=directory.length!==0;
}
function showDirectory(data){
 if(!data||!Array.isArray(data.devices)||!data.csrfToken||!data.expiresAt){throw new Error('The relay returned an invalid directory.');}
 authenticated=true;csrf=data.csrfToken;directoryFresh=true;
 directory=[...data.devices].sort((a,b)=>String(a.deviceId).localeCompare(String(b.deviceId)));
 $('credential').value='';$('welcome').hidden=true;$('dashboard').hidden=false;
 $('main-nav').hidden=false;$('mobile-nav-toggle').hidden=false;
 $('header-status').textContent='AUTHORIZED LOCAL WORKSPACE';
 $('device-count').textContent=String(directory.length);$('home-count').textContent=String(directory.length);
 $('observed-at').textContent=formattedDate(data.observedAt);$('home-refreshed').textContent=formattedDate(data.observedAt);
 $('expires-at').textContent=formattedDate(data.expiresAt);
 renderDirectory();updatePairButton();renderView(currentView);
 clearTimeout(expiryTimer);
 const ms=Math.max(0,Date.parse(data.expiresAt)-Date.now());
 expiryTimer=setTimeout(()=>{
  ++generation;pending?.abort();pending=null;signedOut();message('Your local session expired. Sign in again to refresh your device directory.');
 },ms);
}
function refresh(viewAfter){
 return run(signal=>api('/api/devices',signal),'Refreshing the account directory…',data=>{
  if(viewAfter)currentView=viewAfter;
  showDirectory(data);
 });
}

for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>renderView(button.dataset.view));
$('mobile-nav-toggle').addEventListener('click',()=>{
 const nav=$('main-nav');const open=nav.dataset.open!=='true';nav.dataset.open=String(open);$('mobile-nav-toggle').setAttribute('aria-expanded',String(open));
});
$('signin-form').addEventListener('submit',event=>{
 event.preventDefault();const token=$('credential').value;$('credential').value='';
 currentView='home';void run(signal=>api('/api/session',signal,{method:'POST',body:{token}}),'Checking relay authorization…',showDirectory);
});
$('refresh').addEventListener('click',()=>void refresh());
$('pair-code').addEventListener('input',updatePairButton);
$('pair-owned').addEventListener('change',updatePairButton);
$('pair-form').addEventListener('submit',event=>{
 event.preventDefault();updatePairButton();if($('approve-pair').disabled)return;
 const userCode=$('pair-code').value.trim().toUpperCase();
 $('pair-code').value='';$('pair-owned').checked=false;updatePairButton();
 void run(signal=>api('/api/pair/approve',signal,{method:'POST',body:{userCode,confirmOwnership:true}}),
 'Approving your device pairing code…',()=>queueMicrotask(()=>void refresh('devices')));
});
$('signout').addEventListener('click',()=>{
 const previous=csrf;
 ++generation;pending?.abort();pending=null;signedOut();message('');
 if(previous){const controller=new AbortController();const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
  // The explicit sign-out request preserves the prior CSRF proof, not a discarded session.
  void fetch('/api/logout',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':previous},credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',body:'{}',signal}).catch(()=>{});
 }
});
$('confirmation').addEventListener('input',updateRevokeButton);
$('cancel-revoke').addEventListener('click',()=>{$('revoke-dialog').close();selectedDevice=null;});
$('revoke-dialog').addEventListener('cancel',event=>{if(busy)event.preventDefault();});
$('revoke-form').addEventListener('submit',event=>{
 event.preventDefault();const deviceId=selectedDevice;
 if(!deviceId||busy||$('confirmation').value!==deviceId)return;
 void run(signal=>api(`/api/devices/${encodeURIComponent(deviceId)}/revoke`,signal,{method:'POST',body:{confirmDeviceId:deviceId}}),
 'Revoking relay access…',()=>{
  $('revoke-dialog').close();selectedDevice=null;
  queueMicrotask(()=>void refresh('access'));
 });
});

void run(signal=>api('/api/session',signal),'Checking your local session…',showDirectory,true);
