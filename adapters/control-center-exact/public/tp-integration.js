/*
 * Backend-only behavior adapter. It intentionally adds no CSS, changes no artwork,
 * and preserves the uploaded five-card HTML file byte-for-byte on disk.
 * Runs after the original (classic) script, reusing its existing components.
 */
(function(){
  'use strict';
  const oldRenderPortal=window.renderPortalPage;
  const oldShowPortal=window.showPortalView;
  const oldAppendMiniLog=window.appendMiniLog;
  const oldToggleTheme=window.toggleThemeMode;
  const live={csrf:null,expiresAt:null,relayOrigin:null,devices:[],observedAt:null,directoryUnavailable:false,mutationUncertain:false,inFlight:false};
  const $ = id => document.getElementById(id);
  const text = value => tpEsc(String(value??''));
  const when = value => value ? tpTime(value) : 'Not reported';
  const active = d => d.revokedAt===null;
  const stateLabel = d => d.revokedAt ? 'revoked' : 'paired';
  const presence = d => d.connectivity==='relay_connected' ? 'relay transport connected' : d.connectivity==='relay_disconnected' ? 'relay transport disconnected' : 'connectivity not reported';
  const actions = (...parts)=>parts.join('');
  function log(value){oldAppendMiniLog.call(window,text(String(value).slice(0,2600)));}
  function toast(value){window.showToast(String(value).slice(0,200));}
  function setText(id,value){const node=$(id);if(node)node.textContent=String(value);}
  function clearLive(){
    live.csrf=null;live.expiresAt=null;live.relayOrigin=null;live.devices=[];live.observedAt=null;live.directoryUnavailable=false;live.mutationUncertain=false;
    tpDemo.session=false;tpDemo.devices=[];tpDemo.refreshAt=null;tpDemo.pendingRevokeId=null;
    setText('active-node-summary','SIGN IN REQUIRED');
    setText('mini-console-log','');
  }
  function hydrate(payload){
    if(!payload||!Array.isArray(payload.devices)||typeof payload.csrfToken!=='string')throw Error('Unrecognized session response');
    live.devices=payload.devices;
    live.csrf=payload.csrfToken;
    live.observedAt=payload.observedAt;
    live.expiresAt=payload.expiresAt;
    live.relayOrigin=payload.relayOrigin;
    tpDemo.session=true;
    tpDemo.devices=payload.devices.map(d=>({id:d.deviceId,pairedAt:d.pairedAt,revokedAt:d.revokedAt,status:stateLabel(d),connectivity:d.connectivity}));
    tpDemo.refreshAt=new Date(payload.observedAt);
    setText('active-node-summary',`${payload.devices.length} DIRECTORY RECORDS`);
    live.directoryUnavailable=false;live.mutationUncertain=false;
  }
  async function api(path,{method='GET',body=null,csrf=true}={}) {
    const controller=new AbortController(),tm=setTimeout(()=>controller.abort(),12000);
    try {
      const response=await fetch(path,{method,mode:'same-origin',redirect:'error',cache:'no-store',credentials:'same-origin',signal:controller.signal,
        headers:{accept:'application/json',...(method==='POST'?{'content-type':'application/json'}:{}),...(csrf&&method==='POST'&&live.csrf?{'x-csrf-token':live.csrf}:{})},
        ...(method==='POST'?{body:JSON.stringify(body||{})}:{})});
      if(!(response.headers.get('content-type')||'').startsWith('application/json'))throw Error('Unexpected portal response');
      const data=await response.json();
      if(!response.ok){const e=new Error(data?.error?.message||`HTTP ${response.status}`);e.code=data?.error?.code||'http_error';e.status=response.status;throw e;}
      return data;
    }finally{clearTimeout(tm);}
  }
  function failure(error,mutation=false){
    if(error.status===401){clearLive();oldShowPortal.call(window,'auth');}
    if(mutation)live.mutationUncertain=true;
    const reason=error?.message||'The operation did not complete.';
    log(`[!] ${reason}${mutation?' Refresh directory before any other mutation.':''}`);
    toast(reason);
    if(tpCurrentView!=='home')window.renderActivePortalPage();
  }
  async function refresh({notify=false}={}) {
    if(live.inFlight)return;
    live.inFlight=true;
    try {
      const data=await api('/api/devices');hydrate(data);
      if(tpCurrentView!=='home')window.renderActivePortalPage();
      if(notify){toast('Directory refreshed from authenticated relay');log(`[#] ${live.devices.length} account device record(s).`);}
    }catch(e){live.devices=[];tpDemo.devices=[];tpDemo.refreshAt=null;live.directoryUnavailable=true;live.mutationUncertain=true;setText('active-node-summary','DIRECTORY UNAVAILABLE');failure(e);}
    finally{live.inFlight=false;}
  }
  function cardDevice(d,review=false){
    const id=text(d.deviceId),isActive=active(d);
    const act=review ? `<button class="mono-btn rounded-xl tp-action" onclick="portalReview('${id}')">[ Review access ]</button>` : `<button class="mono-btn rounded-xl tp-action" onclick="openRevoke('${id}')" ${isActive?'':'disabled'}>[ Revoke access ]</button>`;
    return `<div class="tp-entry"><div class="tp-entry-main"><div class="text-white" style="font-size:12px;font-weight:600">${id}</div><div class="tp-dim">${stateLabel(d)} · paired ${text(when(d.pairedAt))} · ${text(presence(d))}${d.revokedAt?' · revoked '+text(when(d.revokedAt)):''}</div></div><div class="tp-actions"><span class="tp-badge">${isActive?'PAIRED':'REVOKED'}</span>${act}</div></div>`;
  }
  function badge(action){return `<button type="button" class="mono-btn rounded-xl tp-action" onclick="${action}">[ Refresh ]</button>`;}
  const originalInfo={...tpPageInfo};
  tpPageInfo.auth=['ACCOUNT ACCESS','Your devices. One quiet place.','Sign in using an existing relay client access credential, verified by the configured relay.'];
  tpPageInfo.control=['CONTROL CENTER','In control. Without the noise.','Account-scoped device information from the authenticated Tetherplane relay.'];
  tpPageInfo.devices=['DEVICES','Your devices.','Only your current account device records; pairing is not proof of availability.'];
  tpPageInfo.access=['ACCESS','Access, on your terms.','Review authenticated device grants, with device-local policy unchanged.'];
  tpPageInfo.pairing=['PAIRING','A new device. Safely connected.','Approve an expiring code generated on a device you are authorized to manage.'];
  tpPageInfo.settings=['SETTINGS','Only what matters.','Current local session and relay facts; no credentials displayed.'];
  tpPageInfo.challenge=['BROWSER CHALLENGE','Identity approval.','Browser authentication is not enabled for this portal.'];
  tpPageInfo.approval=['DEVICE APPROVAL','Device-local authority.','Approvals must be issued by the approved authenticated mechanism, never by a browser flag.'];
  window.renderPortalPage=function(view){
    const ds=live.devices, count=ds.length, now=text(when(live.observedAt));
    if(view==='auth') return tpGrid([
      tpCard('SIGN-IN // EXISTING AUTHORIZATION','Open your workspace.',
        `Enter an already-issued account-scoped relay access credential. It is held by the local server only, in memory, for up to 15 minutes. Browser OAuth/PKCE needs a separately approved client registration.`,
        `<form id="tp-live-login" onsubmit="portalLogin(event)"><label class="tp-label" for="tp-live-token">RELAY CLIENT ACCESS CREDENTIAL</label><input class="tp-input" id="tp-live-token" type="password" autocomplete="off" spellcheck="false" maxlength="8192" placeholder="Authorized bearer credential" required><div class="tp-actions"><button class="mono-btn rounded-xl tp-action" type="submit">[ Sign in ]</button>${tpButton('Back to Plane','home')}</div></form>`),
      tpCard('RELAY AUTHORITY','Account access is explicit.','No demo sign-in, automatic OAuth client creation, device-token reuse or stored browser credentials. For a denied/expired token use your established credential workflow.',tpButton('Security guidance','security'))
    ]);
    if(live.directoryUnavailable&&['control','devices','access','pairing'].includes(view))return tpGrid([
      tpCard('DIRECTORY UNAVAILABLE','Current device state could not be verified.',`Last successful observation: ${now}. Pairing and connectivity are currently unverified. Refresh the directory before another device action.`,badge('refreshPortalDirectory()'))
    ]);
    if(view==='control')return tpGrid([
      tpCard('01 // DIRECTORY','Device directory records',`<div class="tp-card-large text-white">${count}</div><p>Authenticated account records. Paired does not imply online.</p>`,actions(tpButton('View Devices','devices'),tpButton('Add a Device','pairing'))),
      tpCard('02 // LAST REFRESH','Relay directory refresh',`<div class="tp-card-title text-white">${now}</div><p>Last successful authenticated directory observation.</p>`,badge('refreshPortalDirectory()')),
      tpCard('03 // LOCAL POLICY','Device remains final authority','Every MCP call still crosses the original relay, capability policy and on-device authorization.',actions(tpButton('Review Access','access'),tpButton('Capabilities','capabilities'))),
      tpCard('04 // CONNECTIVITY','Paired ≠ online','Live relay transport presence is shown only if actually reported. Otherwise connectivity is not reported.',tpButton('Device directory','devices'))
    ]);
    if(view==='devices')return tpGrid([
      tpCard('ACCOUNT DIRECTORY','Authorized device records',`<div class="tp-card-large text-white">${count}</div>Account-scoped. Device health cannot be inferred from pairing.`,actions(badge('refreshPortalDirectory()'),tpButton('Add a Device','pairing'))),
      tpCard('SEPARATE STATES','Pairing versus transport','The relay may report transport presence. A transport connection is not proof that a requested operation is permitted.',tpButton('Review Access','access'))
    ])+`<article class="mono-glass rounded-2xl p-5 tp-page-card"><div class="tp-kicker">+-- ACCOUNT DEVICE RECORDS</div>${ds.length?ds.map(d=>cardDevice(d,true)).join(''):'<div class="tp-dim" style="margin-top:12px">No devices are paired to this account.</div>'}</article>`;
    if(view==='access')return tpGrid([
      tpCard('SCOPE // ACCOUNT','Relay access grants','Only devices returned for the signed-in account may be managed. The local Policy Broker remains unchanged.'),
      tpCard('DESTRUCTIVE OPERATION','Revocation requires confirmation','Enter the exact case-sensitive device ID. The revoked device must be paired again using a new credential.')
    ])+`<article class="mono-glass rounded-2xl p-5 tp-page-card"><div class="tp-kicker">+-- ACCOUNT GRANTS</div>${ds.length?ds.map(d=>cardDevice(d,false)).join(''):'<div class="tp-dim" style="margin-top:12px">No device grants returned.</div>'}</article>`;
    if(view==='pairing')return tpGrid([
      tpCard('01 // APPROVED PROCESS','Device-side ownership','1. Begin pairing on an authorized device.<p style="margin-top:6px">2. Receive the device-generated one-time code.</p><p style="margin-top:6px">3. Verify the source device and confirm ownership before submitting.</p><p style="margin-top:12px">Approving a code changes real relay account access, not device-local permission grants.</p>'),
      `<article class="mono-glass rounded-2xl p-5 tp-page-card"><div class="tp-kicker">02 // PAIRING FORM</div><div class="tp-content"><h2 class="tp-card-title text-white">Pairing code</h2><p class="tp-dim">Exact code: 4 hexadecimal characters, dash, 4 hexadecimal characters. Never approve an unsolicited code.</p></div><label for="tp-pair-code" class="tp-label">DEVICE CODE</label><input id="tp-pair-code" class="tp-input" maxlength="9" autocomplete="off" spellcheck="false" placeholder="AB12-CD34" oninput="tpPairValidate()"><label class="tp-check"><input type="checkbox" id="tp-pair-ownership" onchange="tpPairValidate()"><span>I initiated pairing on a device I am authorized to manage.</span></label><p id="tp-pair-error" class="tp-error" hidden></p><div class="tp-actions"><button class="mono-btn rounded-xl tp-action" id="tp-pair-submit" onclick="tpPairSubmit()" disabled>[ Approve pairing ]</button><button class="mono-btn rounded-xl tp-action" onclick="tpPairClear()">[ Clear ]</button></div><div id="tp-pair-result" class="tp-dim" style="margin-top:12px" role="status"></div></article>`
    ])+tpNote('Codes are single-use and time-limited. The relay validates the request independently. Uncertain results must be refreshed, not blindly retried.');
    if(view==='settings')return tpGrid([
      tpCard('LOCAL INTERFACE','Authenticated local portal','In-memory session with HttpOnly cookie; no user token is saved in browser storage.'),
      tpCard('RELAY','Configured backend origin',`<span class="tp-code">${text(live.relayOrigin||'Not reported')}</span>`),
      tpCard('AUTHENTICATION','Session expiration',`<span class="tp-code">${text(when(live.expiresAt))}</span>`),
      tpCard('DISPLAY MODE','Theme preference',`Current appearance: <strong class="text-white">${state.ivoryMode?'Light':'Dark'}</strong>.`, `<button type="button" class="mono-btn rounded-xl tp-action" onclick="toggleThemeMode();renderActivePortalPage()">[ Toggle theme ]</button><button type="button" class="mono-btn rounded-xl tp-action" onclick="portalSignOut()">[ Sign out ]</button>`)
    ]);
    if(view==='challenge'||view==='approval')return tpGrid([
      tpCard('AUTHORIZATION BOUNDARY','Not available from the web portal','A browser cannot manufacture a trusted device approval. Continue only through the existing approved device-authenticated TetherAuth workflow.',tpButton('Review security','security')),
      tpCard('NOT AN AUTHORIZATION','No synthetic approval', 'No localStorage approval flag, demo verification code, or replacement OAuth client is treated as real authority.',tpButton('Return to control center','control'))
    ]);
    if(view==='capabilities')return oldRenderPortal.call(window,view).replace('Uninstalled providers and unauthorized operations must return explicit unavailability or permission errors, rather than fabricated success.','Use the existing mini-console: mcp device status Leno {} or mcp files read Leno {"path":"..."}. All six tools route to the authenticated MCP endpoint and still enforce local policy.');
    return oldRenderPortal.call(window,view);
  };
  window.renderMinimalNodes=function(){
    const el=$('minimal-nodes-list');if(!el)return;
    const items=[['#','Device directory','devices'],['*','Pair authorized device','pairing'],['#','Review account access','access'],['+','Capabilities & policy','capabilities']];
    el.replaceChildren();
    for(const [glyph,label,view] of items){
      const btn=document.createElement('button');btn.className='w-full mono-btn rounded-xl px-3 py-2 flex items-center justify-between text-[11px] group';
      btn.innerHTML=`<div class="flex items-center gap-2"><span class="text-white/45 group-hover:text-white transition-colors duration-300">[${glyph}]</span><span class="text-white/90 font-medium">${label}</span></div><div class="flex items-center gap-3"><span class="text-white/45 text-[10px]">${tpDemo.session?'SCOPED':'LOGIN'}</span><span class="text-white/80 font-mono text-[10px] w-8 text-right">→</span></div>`;
      btn.addEventListener('click',()=>oldShowPortal.call(window,view));el.appendChild(btn);
    }
  };
  window.portalLogin=async function(event){
    event?.preventDefault();if(live.inFlight)return;
    const input=$('tp-live-token');const token=input?.value||'';if(input)input.value='';
    if(!token)return;
    live.inFlight=true;
    try{const result=await api('/api/session',{method:'POST',body:{token},csrf:false});hydrate(result);window.renderMinimalNodes();oldShowPortal.call(window,'control');toast('Authenticated account directory loaded');log('[#] Relay account session authorized.');}
    catch(e){failure(e);}
    finally{live.inFlight=false;}
  };
  window.tpSignInUnavailable=function(){oldShowPortal.call(window,'auth');};
  window.startPortalDemo=function(){toast('Synthetic demonstration is disabled in connected mode.');};
  window.portalSignOut=async function(){
    const csrf=live.csrf;
    let confirmed=false;
    try{if(csrf){await api('/api/logout',{method:'POST'});confirmed=true;}}catch{}// Clear page state even when server sign-out is unconfirmed.
    clearLive();window.renderMinimalNodes();oldShowPortal.call(window,'home');
    toast(confirmed?'Local session ended.':'Server sign-out was not confirmed. Reload and retry sign-out before leaving this browser.');
  };
  window.refreshPortalDirectory=function(){void refresh({notify:true});};
  window.portalReview=function(id){oldShowPortal.call(window,'access');const entry=Array.from(document.querySelectorAll('.tp-entry')).find(e=>e.textContent.includes(id));if(entry)entry.scrollIntoView({behavior:'smooth',block:'center'});};
  window.tpPairValidate=function(){
    const inp=$('tp-pair-code'),own=$('tp-pair-ownership'),submit=$('tp-pair-submit');if(!inp||!own||!submit)return false;
    inp.value=inp.value.toUpperCase();const valid=/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(inp.value.trim());
    const okay=valid&&own.checked&&tpDemo.session&&!live.mutationUncertain&&!live.inFlight;
    submit.disabled=!okay;
    const error=$('tp-pair-error');if(error){error.hidden=!inp.value.length||valid;error.textContent='Exact code must use hexadecimal A-F and 0-9 (XXXX-XXXX).';}
    return okay;
  };
  window.tpPairSubmit=async function(){
    if(!window.tpPairValidate())return;const button=$('tp-pair-submit');button.disabled=true;
    const code=$('tp-pair-code').value.trim();
    try{const result=await api('/api/pair/approve',{method:'POST',body:{userCode:code,confirmOwnership:true}});
      const label=$('tp-pair-result');if(label)label.textContent=`Pairing accepted by relay for device ${result.deviceId}. Refresh to verify transport independently.`;
      $('tp-pair-code').value='';$('tp-pair-ownership').checked=false;toast('Device pairing approved by relay');await refresh();
    }catch(e){failure(e,true);}finally{if(button)button.disabled=true;}
  };
  window.openRevoke=function(id){
    const d=live.devices.find(x=>x.deviceId===id);if(!tpDemo.session||!d||!active(d)||live.mutationUncertain)return;
    tpDemo.pendingRevokeId=id;
    setText('tp-modal-device',id);$('tp-revoke-input').value='';$('tp-revoke-confirm').disabled=true;
    setText('tp-revoke-error','');
    const modal=$('tp-modal');
    modal.querySelector('.tp-kicker').textContent='+-- REAL ACCESS REVOCATION';
    modal.querySelector('.tp-dim').textContent='This revokes relay access for the actual account device. A new pairing is required to restore it. Device-local policy is unchanged.';
    modal.hidden=false;$('tp-revoke-input').focus();
  };
  window.confirmRevoke=async function(){
    const id=tpDemo.pendingRevokeId;if(!id||!tpDemo.session||live.mutationUncertain||$('tp-revoke-input').value.trim()!==id)return;
    $('tp-revoke-confirm').disabled=true;
    try{await api(`/api/devices/${encodeURIComponent(id)}/revoke`,{method:'POST',body:{confirmDeviceId:id}});window.closeRevoke();toast('Relay access revoked for '+id);await refresh();}
    catch(e){failure(e,true);window.closeRevoke();}
  };
  window.tpDecideApproval=function(){toast('Real approval must be completed using authorized device infrastructure.');};
  window.tpVerifyChallenge=function(){toast('No browser challenge exists in this portal session.');};
  window.submitMiniCommand=async function(event){
    event?.preventDefault();
    const input=$('mini-cmd-input');const raw=(input?.value||'').trim();if(input)input.value='';if(!raw)return;
    state.pulseIntensity=1;
    const lower=raw.toLowerCase();
    const routes={devices:'devices',pair:'pairing',pairing:'pairing',access:'access',settings:'settings',security:'security',capabilities:'capabilities',overview:'overview',how:'how',home:'home',control:'control',login:'auth',signin:'auth'};
    if(routes[lower]){log(`[>] ${lower}`);oldShowPortal.call(window,routes[lower]);return;}
    if(lower==='help'){log('[+] Navigation: home, devices, pair, access, capabilities, settings. MCP: mcp <device|files|process|browser|desktop|batch> <operation> <device-id|-> <JSON args>.');return;}
    if(lower==='status'){log(tpDemo.session?`[#] Authenticated. ${live.devices.length} directory records at ${when(live.observedAt)}; no inferred agent health.`:'[!] Sign in to query the actual relay.');return;}
    if(lower==='clear'){$('mini-console-log').textContent='';return;}
    if(['theme','ivory','light','dark'].includes(lower)){if(lower==='theme'||lower==='ivory'||(lower==='light'&&!state.ivoryMode)||(lower==='dark'&&state.ivoryMode))oldToggleTheme.call(window);log('[+] Appearance preference updated.');return;}
    if(['zen','peek'].includes(lower)){window.toggleZenMode();return;}
    if(!lower.startsWith('mcp ')){log('[?] Unknown command. Type help. Destructive commands require explicit MCP authority.');return;}
    if(!tpDemo.session){log('[!] Sign in before using MCP.');oldShowPortal.call(window,'auth');return;}
    const match=/^mcp\s+(device|files|process|browser|desktop|batch)\s+([a-z][a-z0-9_]{0,63})\s+(\S+)(?:\s+(\{[\s\S]*\}))?$/i.exec(raw);
    if(!match){log('[!] Expected: mcp <tool> <op> <device-id|-> <JSON args>');return;}
    const tool=match[1].toLowerCase(),op=match[2],device=match[3]==='-'?null:match[3];let args={};
    try{args=match[4]?JSON.parse(match[4]):{};if(!args||Array.isArray(args)||typeof args!=='object')throw Error();}
    catch{log('[!] MCP arguments must be one JSON object.');return;}
    if(live.inFlight){log('[!] Another request is in progress.');return;}
    if(live.mutationUncertain){log('[!] A previous result is unverified. Refresh directory and confirm the action outcome before another MCP command.');return;}
    live.inFlight=true;log(`[>] MCP ${tool}.${op} on ${device||'relay'}`);
    try{const payload=await api('/api/mcp/call',{method:'POST',body:{tool,op,device,args}});const result=payload.result;
      if(result?.isError){
        log('[!] MCP operation denied or failed: '+JSON.stringify(result.structuredContent||result).slice(0,1800));
        const code=result.structuredContent?.error?.code;
        if(['timeout','disconnected'].includes(code))failure(new Error(`MCP result is unverified (${code}). Confirm the action outcome before retrying.`),true);
      }
      else{log('[+] MCP response: '+JSON.stringify(result?.structuredContent||result).slice(0,1800));}
    }catch(e){failure(e,true);}
    finally{live.inFlight=false;}
  };
  window.runQuickCmd=function(value){const input=$('mini-cmd-input');if(input)input.value=value;void window.submitMiniCommand({preventDefault(){}});};
  window.renderMinimalNodes();
  window.addEventListener('load',async()=>{
    setText('active-node-summary','SIGN IN REQUIRED');
    try{const data=await api('/api/session');hydrate(data);window.renderMinimalNodes();if(tpCurrentView!=='home')window.renderActivePortalPage();log('[#] Recovered existing authenticated local session.');}
    catch(e){if(e.status!==401){log('[!] Local portal service unavailable or session could not be checked.');}}
  });
})();
