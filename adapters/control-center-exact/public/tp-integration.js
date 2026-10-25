/*
 * Tetherplane approved five-card adapter: read-only authenticated fleet.
 * The original CSS, ASCII glyphs, animations, controls and theme code are untouched.
 * All requests use existing same-origin session, CSRF, and device-authority boundaries.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const cards = () => Array.from(document.querySelectorAll('main article.card-slot'));
  const loopback = /^http:\/\/127\.0\.0\.1:\d+$/.test(location.origin);
  const live = {authenticated:false,csrf:null,expiresAt:null,observedAt:null,devices:[],
    health:new Map(),visibleCount:4,pending:false,blocked:false,directoryUnavailable:false};
  const short = (value,n=140) => String(value??'').slice(0,n);
  const active = () => live.devices.filter(d=>d.revokedAt===null);
  const status = d => d.revokedAt!==null?'REVOKED':
    live.health.has(d.deviceId)?live.health.get(d.deviceId).label:
    d.connectivity==='relay_disconnected'?'DISCONNECTED':'CHECK REQUIRED';
  const set=(id,value)=>{const el=$(id);if(el)el.textContent=String(value);};
  const pct=(value,total)=>total?Math.max(0,Math.min(100,100*value/total))+'%':'0%';
  function log(message) {
    const root=$('mini-console-log');if(!root)return;
    const row=document.createElement('div');
    row.className='opacity-0 translate-y-1 transition-all duration-500 ease-out';
    const clock=document.createElement('span');clock.className='text-white/35';
    clock.textContent=new Date().toTimeString().slice(0,5);
    row.append(clock,document.createTextNode(' '+short(message,350)));
    root.append(row);
    requestAnimationFrame(()=>row.classList.remove('opacity-0','translate-y-1'));
    root.scrollTop=root.scrollHeight;
    while(root.children.length>30)root.firstElementChild.remove();
  }
  function clearSession() {
    live.authenticated=false;live.csrf=null;live.expiresAt=null;
    live.devices=[];live.observedAt=null;live.health.clear();live.blocked=false;live.directoryUnavailable=false;render();
  }
  async function api(path,method='GET',body=null,options={}) {
    if(!loopback)throw Error('Open the numeric loopback Control Center to use devices.');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    const headers={accept:'application/json'};
    if(method==='POST'){
      headers['content-type']='application/json';
      if(!options.noCsrf && live.csrf)headers['x-csrf-token']=live.csrf;
    }
    try {
      const result=await fetch(path,{method,redirect:'error',credentials:'same-origin',cache:'no-store',
        mode:'same-origin',headers,signal:controller.signal,
        ...(method==='POST'?{body:JSON.stringify(body||{})}:{})});
      if(!(result.headers.get('content-type')||'').startsWith('application/json'))
        throw Error('Unexpected portal response format');
      const payload=await result.json();
      if(!result.ok) {
        const e=Error(short(payload?.error?.message||('HTTP '+result.status),220));
        e.status=result.status;e.code=payload?.error?.code||'request_failed';
        if(result.status===401)clearSession();
        throw e;
      }
      return payload;
    }finally{clearTimeout(timer);}
  }
  function hydrate(p) {
    if(!p || !Array.isArray(p.devices) || typeof p.csrfToken!=='string' ||
      typeof p.expiresAt!=='string'|| typeof p.observedAt!=='string' ||
      !p.devices.every(d=>d&&typeof d.deviceId==='string' &&
        (d.revokedAt===null||typeof d.revokedAt==='string')))throw Error('Invalid account directory');
    live.authenticated=true;live.csrf=p.csrfToken;live.expiresAt=p.expiresAt;
    live.observedAt=p.observedAt;live.devices=p.devices;live.health.clear();
    live.blocked=false;live.directoryUnavailable=false;
    live.visibleCount=Math.min(Math.max(1,live.visibleCount),Math.max(1,p.devices.length));
    render();
  }
  function renderAuth() {
    set('tp-auth-action',live.authenticated?'[ Sign out ]':'[ Sign in with approved OAuth ]');
    const form=$('tp-auth-form');if(form)form.hidden=true;
    if(!live.authenticated) set('tp-session-label','EXISTING APPROVED RELAY ACCESS REQUIRED');
    else {
      const minutes=Math.max(0,Math.ceil((Date.parse(live.expiresAt)-Date.now())/60000));
      set('tp-session-label','SESSION EXPIRES IN '+minutes+' MIN · DEVICE-LOCAL POLICY FINAL');
    }
  }
  function renderTelemetry() {
    const paired=active(),verified=paired.filter(d=>live.health.has(d.deviceId));
    const ready=paired.filter(d=>live.health.get(d.deviceId)?.label==='READY').length;
    const reported=paired.filter(d=>['relay_connected','relay_disconnected'].includes(d.connectivity)).length;
    set('tel-hash',live.authenticated?(paired.length+' / '+live.devices.length+' paired'):'SIGN IN REQUIRED');
    set('tel-star',live.authenticated?(ready+' ready · '+verified.length+' checked'):'NO AGENT OBSERVATION');
    set('tel-plus',live.authenticated?(reported+' / '+paired.length+' reported'):'NO DIRECTORY DATA');
    for(const [id,v,t] of [['bar-hash',paired.length,live.devices.length],
      ['bar-star',ready,paired.length],['bar-plus',reported,paired.length]]){
      const bar=$(id);if(bar)bar.style.width=pct(v,t);
    }
    set('active-node-summary',live.authenticated?(live.directoryUnavailable?'DIRECTORY UNAVAILABLE':live.devices.length+' ACCOUNT RECORDS'):'SIGN IN REQUIRED');
  }
  function renderDevices() {
    const box=$('minimal-nodes-list');if(!box)return;
    box.replaceChildren();
    if(!live.authenticated||!live.devices.length){
      const info=document.createElement('div');info.className='text-[11px] text-white/55';
      info.textContent=live.authenticated?'No devices returned by the relay.':'Sign in to view account devices.';
      box.append(info);return;
    }
    for(const d of live.devices.slice(0,live.visibleCount)){
      const button=document.createElement('button');button.type='button';
      button.className='w-full mono-btn rounded-xl px-3 py-2 flex items-center justify-between text-[11px] group';
      const left=document.createElement('div');left.className='flex items-center gap-2';
      const glyph=document.createElement('span');
      glyph.className='text-white/45 group-hover:text-white transition-colors duration-300';
      glyph.textContent='[#]';
      const name=document.createElement('span');name.className='text-white/90 font-medium';
      name.textContent=short(d.deviceId,128);left.append(glyph,name);
      const right=document.createElement('span');right.className='text-white/65 font-mono text-[10px]';
      right.textContent=status(d);
      button.append(left,right);
      button.disabled=live.pending||d.revokedAt!==null;
      button.title=d.revokedAt?'Revoked device':'Check actual authenticated agent status';
      if(d.revokedAt===null)button.addEventListener('click',()=>{void probe(d.deviceId);});
      box.append(button);
    }
  }
  function renderSlider(){
    const input=$('capacity-slider');if(!input)return;
    input.min='1';input.max=String(Math.max(1,live.devices.length));input.step='1';
    input.value=String(Math.min(live.visibleCount,Number(input.max)));
    const count=live.authenticated?Math.min(live.devices.length,live.visibleCount):0;
    set('scale-tier-label','DISPLAY ONLY');set('price-val',count);
    const unit=$('price-val')?.nextElementSibling;if(unit)unit.textContent=' devices shown';
    set('nodes-count-label',count);set('flux-count-label',live.devices.length+' total');
    const progress=$('slider-fill-bar');if(progress)progress.style.width=pct(count,live.devices.length);
    const meter=$('ascii-scale-meter');if(meter){
      const total=28,on=live.devices.length?Math.round(28*count/live.devices.length):0;
      const parts=document.createElement('span');
      for(const [label,klass] of [['[','text-white/40'],
        ['#'.repeat(on),'text-white font-bold'],
        ['+'.repeat(total-on),'text-white/20'],[']','text-white/40']]){
        const part=document.createElement('span');part.className=klass;part.textContent=label;parts.append(part);
      }
      meter.replaceChildren(parts);
    }
  }
  function render(){renderAuth();renderTelemetry();renderDevices();renderSlider();}
  async function refresh(){
    if(live.pending)return;
    live.pending=true;
    try {
      hydrate(await api('/api/devices'));
      state.pulseIntensity=1;
      log('[#] Directory refreshed: '+live.devices.length+' account records. Status checks remain explicit.');
    }catch(e){live.directoryUnavailable=true;live.blocked=e.status!==401;log('[!] Directory unavailable: '+short(e.message,170));}
    finally{live.pending=false;render();}
  }
  function interpret(result) {
    if(result?.isError||result?.structuredContent?.error){
      const code=result?.structuredContent?.error?.code;
      return {label:code==='disconnected'?'DISCONNECTED':code==='permission_denied'?'DENIED':'UNAVAILABLE'};
    }
    const data=result?.structuredContent;
    if(!data||typeof data.agent_version!=='string')return {label:'UNVERIFIED'};
    const liveness=data.agent_liveness?.state;
    return {label:liveness==='ready'?'READY':liveness==='offline'?'OFFLINE':'AGENT RESPONDED',
      version:short(data.agent_version,24)};
  }
  async function probe(deviceId) {
    if(!live.authenticated){log('[!] Sign in before checking an agent.');return;}
    const record=live.devices.find(d=>d.deviceId===deviceId&&d.revokedAt===null);
    if(!record){log('[!] Device not paired to this account.');return;}
    if(live.pending||live.blocked){log('[!] Another operation is in progress or a refresh is needed.');return;}
    if(record.connectivity==='relay_disconnected'){
      live.health.set(deviceId,{label:'DISCONNECTED'});render();return;
    }
    live.pending=true;renderDevices();
    log('[>] Requesting authenticated device.status on '+short(deviceId));
    try{
      const response=await api('/api/mcp/call','POST',{tool:'device',op:'status',device:deviceId,args:{}});
      const seen=interpret(response?.result);live.health.set(deviceId,seen);
      if(response?.result?.isError && seen.label!=='DENIED')live.blocked=true;
      log('['+(seen.label==='READY'?'+':'!')+'] '+short(deviceId)+': '+seen.label+
        (seen.version?' ('+seen.version+')':''));
    }catch(e){
      live.health.set(deviceId,{label:e.code==='disconnected'?'DISCONNECTED':e.status===403?'DENIED':'UNAVAILABLE'});
      if(e.status!==401)live.blocked=true;
      log('[!] '+short(deviceId)+': '+short(e.message,170));
    }finally{live.pending=false;render();}
  }
  async function signOut(){
    if(live.pending)return;
    live.pending=true;
    let confirmed=false;
    try{if(live.csrf){await api('/api/logout','POST',{});confirmed=true;}}
    catch{log('[!] Server sign-out not confirmed. Local session cleared; reload and retry if necessary.');}
    finally{live.pending=false;clearSession();if(confirmed)log('[#] Local portal session ended.');}
  }
  function authAction(){
    if(live.authenticated){void signOut();return;}
    if(!loopback || live.pending){log('[!] Browser OAuth requires the approved local Control Center.');return;}
    void beginApprovedOAuth();
  }
  async function beginApprovedOAuth(){
    live.pending=true;
    try{
      const response=await fetch('/api/oauth/start',{
        method:'POST',mode:'same-origin',credentials:'same-origin',redirect:'error',cache:'no-store',
        headers:{accept:'application/json','content-type':'application/json','x-tetherplane-intent':'oauth'},
        body:'{}',signal:AbortSignal.timeout(15000)
      });
      const result=await response.json();
      if(!response.ok)throw Error(short(result?.error?.message||'Approved OAuth unavailable',180));
      const target=new URL(result.authorizationUrl);
      if(target.protocol!=='https:' ||
         target.username||target.password||target.hash)throw Error('Unexpected authorization destination');
      window.location.assign(target.href);
    }catch(e){log('[!] Sign-in could not start: '+short(e.message,160));}
    finally{live.pending=false;}
  }
  async function command(raw) {
    const value=String(raw||'').trim();if(!value)return;
    const cmd=value.toLowerCase();
    if(cmd==='help'){log('[+] devices · status DEVICE · refresh · login · signout · access · repo · help · theme · focus · clear');return;}
    if(cmd==='clear'){$('mini-console-log')?.replaceChildren();return;}
    if(cmd==='theme'){window.toggleThemeMode();return;}
    if(cmd==='focus'){window.toggleZenMode();return;}
    if(cmd==='repo'){window.copyInstallCmd();return;}
    if(cmd==='login'){authAction();return;}
    if(cmd==='signout'){await signOut();return;}
    if(cmd==='access'){log('[#] Access grants, pairing and revocation remain in the existing authorized Control Center. No privilege changes here.');return;}
    if(cmd==='devices'){
      if(!live.authenticated){log('[!] Sign in first.');return;}
      log('[#] '+live.devices.map(d=>short(d.deviceId,128)+'='+status(d)).join(' · '));return;
    }
    if(cmd==='refresh'){await refresh();return;}
    const match=/^status\s+([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/i.exec(value);
    if(match){
      const d=live.devices.find(d=>d.deviceId.toLowerCase()===match[1].toLowerCase());
      if(d)await probe(d.deviceId);else log('[!] Device not found in account directory.');
      return;
    }
    log('[!] Unsupported command. Nothing executed; type help.');
  }
  function install() {
    const all=cards();
    if(all.length!==5)throw Error('Approved five-card layout missing');
    const [identity,telemetry,directory,scale,terminal]=all;
    const hero=identity.querySelector('.pt-1');
    if(!hero)throw Error('Approved identity card missing');
    hero.classList.add('space-y-2.5');
    const auth=document.createElement('button');auth.id='tp-auth-action';auth.type='button';
    auth.className='w-full group mono-btn rounded-xl px-3.5 py-2.5 flex items-center justify-between text-[11px] text-left';
    auth.addEventListener('click',authAction);hero.append(auth);
    const sess=document.createElement('div');sess.id='tp-session-label';
    sess.className='text-[10px] text-white/45';hero.append(sess);

    const setHeading=(el,value)=>{
      const node=el.querySelector('div.flex.items-center.justify-between > span');
      if(node)node.textContent=value;
    };
    setHeading(telemetry,'[02] AUTHENTICATED FLEET METRICS');
    setHeading(directory,'[03] ACCOUNT DEVICE DIRECTORY');
    setHeading(scale,'[04] FLEET DISPLAY COUNT');
    setHeading(terminal,'[05] READ-ONLY DEVICE CONSOLE');
    for(const [id,label] of [['tel-hash','Paired devices'],
      ['tel-star','Verified readiness'],['tel-plus','Relay presence']]){
      const value=$(id),heading=value?.parentElement?.firstElementChild;
      if(heading?.lastChild?.nodeType===Node.TEXT_NODE)heading.lastChild.textContent=' '+label;
    }
    const reload=telemetry.querySelector('button[onclick="pulseMatrixTelemetry()"]');
    if(reload)reload.textContent='[Refresh ↻]';
    terminal.querySelectorAll('button').forEach((btn,i)=>{
      const cmd=['devices','refresh','help'][i];if(!cmd)return;
      btn.removeAttribute('onclick');btn.textContent='['+cmd+']';
      btn.addEventListener('click',()=>{void command(cmd);});
    });
    const input=$('mini-cmd-input');
    if(input)input.placeholder='devices · status DEVICE · refresh · help';
    $('mini-console-log')?.replaceChildren();
    window.renderMinimalNodes=renderDevices;
    window.rekeySingleNode=()=>log('[!] No rekey action is available in this read-only view.');
    window.pulseMatrixTelemetry=()=>{state.pulseIntensity=1;void refresh();};
    window.handleCapacitySlide=value=>{
      live.visibleCount=Math.max(1,Math.min(Number(value)||1,Math.max(1,live.devices.length)));
      renderDevices();renderSlider();
    };
    window.submitMiniCommand=event=>{
      event?.preventDefault();const f=$('mini-cmd-input');const raw=f?.value||'';
      if(f)f.value='';void command(raw);
    };
    window.runQuickCmd=value=>{void command(value);};
    log('[#] Read-only authenticated fleet. Sign in to view account devices.');
    log('[#] Pairing, revocation and permission edits remain protected.');
    render();
  }
  window.addEventListener('load',()=>{
    try{install();}catch(e){console.error('Tetherplane staging adapter could not initialize');return;}
    if(!loopback){log('[!] Local HTML preview cannot access the authenticated relay.');return;}
    (async()=>{
      try{hydrate(await api('/api/session'));log('[#] Recovered an existing authenticated session.');}
      catch(e){log(e.status===401?'[#] Sign in required.':'[!] Session check unavailable; no device status inferred.');}
    })();
  });
})();
