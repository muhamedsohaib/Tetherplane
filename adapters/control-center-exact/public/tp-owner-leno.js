/* Opt-in Leno-only owner grants. Additive to the accepted V5 UI;
 * neither portal audit nor device-local permissions are changed here. */
(()=>{
 "use strict";
 const state={owner:null,csrf:null,busy:false,uncertain:false};
 const $=id=>document.getElementById(id);
 const el=(tag,cls,text,parent)=>{
   const node=document.createElement(tag);
   if(cls)node.className=cls;
   if(text!==null&&text!==undefined)node.textContent=String(text);
   if(parent)parent.appendChild(node);
   return node;
 };
 const info=(message)=>{if($("tp-leno-owner-result"))$("tp-leno-owner-result").textContent=String(message);};
 async function request(route,method="GET",body=null,csrf=null) {
   const response=await fetch(route,{
     method,mode:"same-origin",redirect:"error",credentials:"same-origin",cache:"no-store",
     signal:AbortSignal.timeout(12000),
     headers:{accept:"application/json",...(body?{"content-type":"application/json"}:{}),
       ...(csrf?{"x-csrf-token":csrf}:{})},
     ...(body?{body:JSON.stringify(body)}:{})
   });
   if(!(response.headers.get("content-type")||"").startsWith("application/json"))
     throw Error("Unrecognized owner management response");
   const data=await response.json();
   if(!response.ok)throw Error(String(data?.error?.message||"Owner action denied").slice(0,160));
   return data;
 }
 function controls() {
   const ready=state.owner&&!state.busy&&!state.uncertain;
   const enforced=state.owner?.enforcedDevices?.includes("Leno")===true;
   const grants=state.owner?.grants?.filter(g=>g.deviceId==="Leno"&&g.level==="full")||[];
   const select=$("tp-leno-owner-client");
   if(select) {
     const before=select.value;
     select.replaceChildren();
     for(const c of state.owner?.clients||[]) {
       const option=el("option",null,c.clientId+" / "+c.principalId,select);
       option.value=JSON.stringify([c.clientId,c.principalId]);
     }
     if(Array.from(select.options).some(o=>o.value===before))select.value=before;
   }
   if($("tp-leno-owner-state"))$("tp-leno-owner-state").textContent=
     !state.owner?"Not verified; request the current owner snapshot":
     "Revision "+state.owner.revision+" — global policy "+(state.owner.enabled?"ENABLED":"disabled")+
     " — Leno "+(enforced?"ENFORCED":"legacy routing")+
     " — Leno Full Control grants: "+grants.length+
     " — Surface, RTX and VAULTER unchanged by this control";
   if($("tp-leno-owner-stage"))$("tp-leno-owner-stage").disabled=!ready||
     enforced||state.owner.enabled||!select?.value;
   if($("tp-leno-owner-apply"))$("tp-leno-owner-apply").disabled=!ready||
     state.owner.enabled||(!enforced&&!grants.length);
   if($("tp-leno-owner-apply"))$("tp-leno-owner-apply").textContent=
     enforced?"[ Restore Leno legacy routing ]":"[ Enforce Leno only ]";
   const confirmation=$("tp-leno-owner-enforce-confirm");
   if(confirmation)confirmation.placeholder=enforced?"RESTORE Leno LEGACY ACCESS":"ENFORCE Leno GRANTS";
 }
 async function refresh() {
   if(state.busy)return;
   state.busy=true;controls();info("Verifying current owner session and relay policy...");
   try {
     const sess=await request("/api/session");
     if(!sess.authenticated||typeof sess.csrfToken!=="string")
       throw Error("Authenticated Control Center session required");
     const snap=await request("/api/owner-leno");
     if(!Number.isSafeInteger(snap.revision)||!Array.isArray(snap.clients)||
       !Array.isArray(snap.grants)||!Array.isArray(snap.enforcedDevices))
       throw Error("Owner relay state is not verifiable");
     state.csrf=sess.csrfToken;state.owner=snap;state.uncertain=false;
     info("Owner policy verified. Changes require exact typed confirmation.");
   }catch(e){state.owner=null;state.csrf=null;state.uncertain=true;info(e.message);}
   finally{state.busy=false;controls();}
 }
 async function mutate(route,body) {
   if(!state.owner||state.uncertain||state.busy||!state.csrf)return;
   state.busy=true;controls();info("Submitting owner-controlled Leno action...");
   try {
     const result=await request(route,"POST",body,state.csrf);
     if(!Number.isSafeInteger(result.revision)||result.revision!==body.revision+1)
       throw Error("Unverified policy revision. Refresh current state.");
     // Never presume successful enforcement solely from the mutation reply.
     state.owner=null;state.uncertain=true;info("Leno change submitted. Refresh to verify effective policy.");
   }catch(e){state.owner=null;state.uncertain=true;info("Owner action not confirmed: "+e.message+". Refresh before retry.");}
   finally{state.busy=false;controls();}
 }
 async function stage() {
   const owner=state.owner;
   if(!owner||state.busy||state.uncertain)return;
   const selected=$("tp-leno-owner-client")?.value||"";
   let ids;
   try{ids=JSON.parse(selected);}catch{info("Select a verified observed AI client");return;}
   if(!Array.isArray(ids)||ids.length!==2||!owner.clients.some(c=>c.clientId===ids[0]&&c.principalId===ids[1]))return;
   if($("tp-leno-owner-stage-confirm")?.value!=="TRUST Leno"){
     info("Type TRUST Leno to stage the exact-client grant.");return;
   }
   await mutate("/api/owner-leno/grant",{
     revision:owner.revision,clientId:ids[0],principalId:ids[1],confirmation:"TRUST Leno"
   });
 }
 async function enforce() {
   const owner=state.owner;
   if(!owner||state.busy||state.uncertain||owner.enabled)return;
   const enabled=!owner.enforcedDevices.includes("Leno");
   const phrase=enabled?"ENFORCE Leno GRANTS":"RESTORE Leno LEGACY ACCESS";
   if($("tp-leno-owner-enforce-confirm")?.value!==phrase){
     info("Type "+phrase+" to confirm this Leno-only action.");return;
   }
   await mutate("/api/owner-leno/enforcement",{revision:owner.revision,enabled,confirmation:phrase});
 }
 function install() {
   const panel=$("tp-authority-panel");
   if(!panel||$("tp-leno-owner-section"))return;
   const section=el("section","tp-auth-section",null,panel);
   section.id="tp-leno-owner-section";
   el("h3","text-sm font-bold","OWNER FULL CONTROL — LENO ONLY",section);
   el("p","tp-auth-note","Optional relay grant for one already authenticated AI client. This does not modify the original V5 restrictions, pairing, Windows ACLs, browser consent or other devices.",section);
   el("p","tp-auth-note","Read-only until owner identity is verified. Unknown OAuth clients are never selectable.",section);
   el("p","tp-auth-note","Not verified; request the current owner snapshot",section).id="tp-leno-owner-state";
   const refreshRow=el("div","tp-auth-row",null,section);
   const refreshBtn=el("button","mono-btn","[ Verify owner authority ]",refreshRow);
   refreshBtn.type="button";refreshBtn.addEventListener("click",()=>{void refresh();});
   const clientLabel=el("label","tp-auth-note","Observed authenticated AI client",section);
   el("select","tp-auth-input",null,clientLabel).id="tp-leno-owner-client";
   const stageLabel=el("label","tp-auth-note","Type TRUST Leno to stage a Full Control grant",section);
   const stageConfirm=el("input","tp-auth-input",null,stageLabel);
   stageConfirm.id="tp-leno-owner-stage-confirm";stageConfirm.autocomplete="off";
   const stageBtn=el("button","mono-btn","[ Stage Leno Full Control ]",section);
   stageBtn.type="button";stageBtn.id="tp-leno-owner-stage";stageBtn.disabled=true;
   stageBtn.addEventListener("click",()=>{void stage();});
   const activateLabel=el("label","tp-auth-note","Type ENFORCE Leno GRANTS (or RESTORE Leno LEGACY ACCESS)",section);
   const activateConfirm=el("input","tp-auth-input",null,activateLabel);
   activateConfirm.id="tp-leno-owner-enforce-confirm";activateConfirm.autocomplete="off";
   const applyBtn=el("button","mono-btn","[ Enforce Leno only ]",section);
   applyBtn.type="button";applyBtn.id="tp-leno-owner-apply";applyBtn.disabled=true;
   applyBtn.addEventListener("click",()=>{void enforce();});
   el("p","tp-auth-note","No operation runs until the current exact owner grant has been verified after staging. Browser-provider installation and UI foreground consent remain separate.",section);
   const result=el("p","tp-auth-note","Owner state not loaded.",section);
   result.id="tp-leno-owner-result";result.setAttribute("role","status");
   controls();
 }
 window.addEventListener("load",install);
})();