import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/tp-integration.js',import.meta.url),'utf8');
class Node {
 constructor(){this.children=[];this.textContent='';this.className='';this.attrs={};this.removed=false;this.classList={remove:()=>{}};}
 appendChild(v){this.children.push(v);return v;}
 replaceChildren(...a){this.children=a;}
 setAttribute(k,v){this.attrs[k]=v;}
 removeAttribute(k){delete this.attrs[k];}
 remove(){this.removed=true;}
 addEventListener(name,handler){(this.handlers ||= {})[name]=handler;}
}
const contentOf=e=>[e?.textContent||'',...(e?.children||[]).map(contentOf)].join(' ');
const data={devices:[{deviceId:'Leno',pairedAt:'2026-10-24T00:00:00Z',revokedAt:null,connectivity:'relay_connected'},{deviceId:'RTX',pairedAt:'2026-10-24T00:00:00Z',revokedAt:null,connectivity:'relay_disconnected'}],csrfToken:'synthetic-csrf',expiresAt:new Date(Date.now()+600000).toISOString(),observedAt:new Date().toISOString(),relayOrigin:'https://relay.invalid'};
const response=o=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>o});
async function setup(){
 const zen=new Node();zen.id='zen-btn';
 const art=new Node();art.attrs.onclick='toggleZenMode()';art.attrs.title='Artwork';
 const slider=new Node();slider.id='capacity-slider';
 const card=new Node();card.children=[slider];slider.closest=()=>card;
 const tel=new Node();tel.id='tel-hash';
 const telemetry=new Node();telemetry.children=[tel];tel.closest=()=>telemetry;
 const cta=new Node();cta.attrs.onclick="showPortalView('auth')";
 const logNode=new Node();logNode.textContent='UI [#] Static interface preview — no live relay.';
 const nodes=new Map([['zen-btn',zen],['capacity-slider',slider],['mini-console-log',logNode],['active-node-summary',new Node()],['tel-hash',tel]]);
 const find=(e,id)=>e.id===id?e:e.children.map(c=>find(c,id)).find(Boolean)||null;
 const calls=[],logs=[],nav=[];let load;
 const ctx={document:{getElementById:id=>nodes.get(id)||find(card,id)||find(telemetry,id),querySelector:s=>s.includes('toggleZenMode')?art:s.includes('showPortalView')?cta:null,createElement:()=>new Node()},tpDemo:{session:false},tpPageInfo:{},tpCurrentView:'home',state:{},tpEsc:String,tpTime:String,tpGrid:a=>a.join(''),tpCard:(...a)=>a.join(''),tpButton:()=>'',tpNote:()=>'',renderPortalPage:()=>'',showPortalView:v=>nav.push(v),appendMiniLog:x=>logs.push(x),toggleThemeMode:()=>{},showToast:()=>{},renderActivePortalPage:()=>{},addEventListener:(e,fn)=>{if(e==='load')load=fn},AbortController,setTimeout,clearTimeout,setInterval:()=>0,fetch:async(path,opt)=>{calls.push({path,body:opt.body?JSON.parse(opt.body):null});if(path==='/api/session'||path==='/api/devices')return response(data);if(path==='/api/mcp/call')return response({result:{structuredContent:{agent_version:'0.1.0',agent_liveness:{state:'ready',transport:'authenticated'}}}});throw Error('Wrong endpoint '+path)}};
 ctx.window=ctx;vm.runInNewContext(source,ctx);await load();
 return {ctx,zen,art,card,telemetry,cta,nav,logNode,calls,logs,view:()=>contentOf(card)};
}
test('home removes artwork actions and onboarding guide but retains authenticated fleet',async()=>{
 const p=await setup();
 assert.equal(p.zen.removed,true);
 assert.equal('onclick' in p.art.attrs,false);
 assert.equal('title' in p.art.attrs,false);
 assert.equal(p.card.attrs['data-tp-fleet'],'true');
 assert.match(p.view(),/Leno/);
 assert.match(p.view(),/RTX/);
 assert.match(p.view(),/disconnected/i);
 assert.doesNotMatch(p.view(),/Onboarding Guide|STEP 01|INSTALL/);
 assert.doesNotMatch(p.logNode.textContent,/Static interface preview/);
 assert.equal(p.calls.filter(x=>x.path==='/api/mcp/call').length,0);
});
test('device status is authorized, read-only, and never invents offline RTX health',async()=>{
 const p=await setup();
 await p.ctx.portalDeviceStatus('Leno');
 const calls=p.calls.filter(x=>x.path==='/api/mcp/call');
 assert.equal(calls.length,1);
 assert.equal(calls[0].body.tool,'device');
 assert.equal(calls[0].body.op,'status');
 assert.equal(calls[0].body.device,'Leno');
 assert.match(p.view(),/ready/i);
 await p.ctx.portalDeviceStatus('NotOwned');
 await p.ctx.portalDeviceStatus('RTX');
 assert.equal(p.calls.filter(x=>x.path==='/api/mcp/call').length,1);
 assert.doesNotMatch(p.view(),/RTX.*ready/i);
});

test('connection architecture no longer displays fabricated progress bars and home CTA respects session',async()=>{
 const p=await setup();
 assert.equal(p.telemetry.attrs['data-tp-session'],'true');
 assert.match(contentOf(p.telemetry),/authenticated/i);
 assert.doesNotMatch(contentOf(p.telemetry),/33.33|66.67|100%|TLS \/ WSS/);
 assert.equal('onclick' in p.cta.attrs,false);
 assert.equal(typeof p.cta.handlers?.click,'function');
 p.cta.handlers.click();
 assert.equal(p.nav.at(-1),'control');
 p.ctx.tpDemo.session=false;
 p.cta.handlers.click();
 assert.equal(p.nav.at(-1),'auth');
});
