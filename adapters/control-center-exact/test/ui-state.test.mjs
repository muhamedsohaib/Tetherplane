// Regression coverage for the approved five-card adapter (no proprietary artwork loaded).
// Exercises the actual production browser script with controlled DOM and transport inputs.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setImmediate as nextTurn} from 'node:timers/promises';
import vm from 'node:vm';
import test from 'node:test';

const script=await readFile(new URL('../public/tp-integration.js',import.meta.url),'utf8');
const SESSION={
  devices:[{deviceId:'SyntheticDevice',pairedAt:'2026-10-23T00:00:00Z',
    revokedAt:null,connectivity:'not_reported'}],
  csrfToken:'synthetic-csrf',observedAt:'2026-10-23T00:00:00Z',
  expiresAt:'2032-01-01T00:15:00Z',relayOrigin:'https://relay.invalid',authenticated:true
};
const json=(payload,status=200)=>({ok:status>=200&&status<300,status,
  headers:{get:()=> 'application/json'},json:async()=>payload});
class FakeNode {
  constructor(tag='div',id='') {
    this.tagName=tag.toUpperCase();this.id=id;this.childNodes=[];
    this.style={};this.dataset={};this.value='';this.hidden=false;
    this.classList={add(){},remove(){}};
    this.listeners={};this._text='';this.parentElement=null;this.nodeType=1;
  }
  set textContent(value){this._text=String(value);this.childNodes=[];}
  get textContent(){return this._text+this.childNodes.map(x=>x.textContent??'').join('');}
  get children(){return this.childNodes.filter(x=>x.nodeType===1);}
  get firstElementChild(){return this.children[0]||null;}
  get lastChild(){return this.childNodes.at(-1)||null;}
  append(...things){for(const thing of things){
    const node=typeof thing==='string'?Object.assign(new FakeNode('#text'),{nodeType:3,_text:thing}):thing;
    node.parentElement=this;this.childNodes.push(node);
  }}
  replaceChildren(...items){this._text='';this.childNodes=[];this.append(...items);}
  addEventListener(type,handler){this.listeners[type]=handler;}
  removeAttribute(){}
  remove(){if(this.parentElement){
    this.parentElement.childNodes=this.parentElement.childNodes.filter(x=>x!==this);
  }}
  querySelector(selector){
    if(selector==='.pt-1')return this.hero||null;
    if(selector==='div.flex.items-center.justify-between > span')return this.heading||null;
    if(selector==='button[onclick="pulseMatrixTelemetry()"]')return null;
    return null;
  }
  querySelectorAll(selector){if(selector==='button')return this.buttons||[];return [];}
}
async function page(firstResult,config={}){
  const nodes=new Map();
  for(const id of ['mini-cmd-input','mini-console-log','active-node-summary',
    'capacity-slider','minimal-nodes-list','tp-auth-action','tp-session-label'])
    nodes.set(id,new FakeNode('div',id));
  const cards=Array.from({length:5},()=>new FakeNode('article'));
  cards[0].hero=new FakeNode('div');
  cards[4].buttons=Array.from({length:3},()=>new FakeNode('button'));
  const document={
    getElementById:id=>nodes.get(id)||null,
    querySelectorAll:s=>s==='main article.card-slot'?cards:[],
    createElement:tag=>new FakeNode(tag),
    createTextNode:text=>Object.assign(new FakeNode('#text'),{nodeType:3,_text:String(text)})
  };
  const requests=[];
  let load,failDirectory=false,failLogout=false,navigation=null;
  const ctx={
    document,location:{origin:'http://127.0.0.1:8791',assign:url=>{navigation=url;}},
    Node:{TEXT_NODE:3},
    requestAnimationFrame:callback=>callback(),
    AbortController,AbortSignal,setTimeout,clearTimeout,
    Date,console,URL,
    state:{pulseIntensity:0},
    addEventListener:(type,callback)=>{if(type==='load')load=callback;},
    toggleThemeMode(){},toggleZenMode(){},copyInstallCmd(){},
    fetch:async(path,options)=>{
      requests.push({path,method:options?.method||'GET',body:options?.body});
      if(path==='/api/logout'){
        if(failLogout)throw Error('Synthetic logout network outage');
        return json({signedOut:true});
      }
      if(path==='/api/devices'&&failDirectory)
        return json({error:{code:'relay_unavailable',message:'Synthetic directory outage'}},502);
      if(path==='/api/session'&&config.unauthenticated)
        return json({error:{code:'authentication_required'}},401);
      if(path==='/api/oauth/start')return json({authorizationUrl:config.oauthDestination});
      if(path==='/api/session'||path==='/api/devices')return json(SESSION);
      if(path==='/api/mcp/call'){
        if(requests.filter(x=>x.path==='/api/mcp/call').length===1)return firstResult();
        return json({result:{isError:false,structuredContent:{
          agent_version:'0.1.0',agent_liveness:{state:'ready'}}}});
      }
      throw Error('Unexpected API '+path);
    }
  };
  ctx.window=ctx;
  vm.runInNewContext(script,ctx,{filename:'tp-integration.js'});
  assert.equal(typeof load,'function');
  load();
  await settle();
  async function settle(){for(let i=0;i<5;i++)await nextTurn();}
  async function cmd(command){
    ctx.runQuickCmd(command);
    await settle();
  }
  async function refresh(fail=false){
    failDirectory=fail;
    await cmd('refresh');
  }
  const log=()=>nodes.get('mini-console-log').textContent;
  const calls=()=>requests.filter(x=>x.path==='/api/mcp/call').length;
  return {ctx,nodes,cards,requests,cmd,refresh,log,calls,
    navigated:()=>navigation,failLogout:()=>{failLogout=true;}};
}

for(const scenario of ['transport failure','timeout','disconnected']){
  test('status requests are fenced after '+scenario+' until an explicit successful directory refresh',async()=>{
    const p=await page(()=>{
      if(scenario==='transport failure')throw Error('Synthetic transport failure');
      return json({result:{isError:true,structuredContent:{
        error:{code:scenario,message:'Synthetic unknown result'}}}});
    });
    await p.cmd('status SyntheticDevice');
    await p.cmd('status SyntheticDevice');
    assert.equal(p.calls(),1,'uncertain status cannot trigger another immediate operation');
    await p.refresh(true);
    assert.match(p.log(),/Directory unavailable/);
    await p.cmd('status SyntheticDevice');
    assert.equal(p.calls(),1,'failed refresh must preserve safety fence');
    await p.refresh();
    assert.equal(p.calls(),1,'refresh must never replay a prior operation');
    await p.cmd('status SyntheticDevice');
    assert.equal(p.calls(),2,'successful refresh must permit a newly requested status call');
  });
}
test('definite permission_denied is reported as DENIED and does not indefinitely block status',async()=>{
  const p=await page(()=>json({result:{isError:true,structuredContent:{
    error:{code:'permission_denied',message:'Policy denied'}}}}));
  await p.cmd('status SyntheticDevice');
  await p.cmd('status SyntheticDevice');
  assert.equal(p.calls(),2);
  assert.match(p.log(),/DENIED/);
});
test('failed directory refresh clearly labels unavailable state, never invents zero paired devices',async()=>{
  const p=await page(()=>json({result:{isError:false,structuredContent:{}}}));
  await p.refresh(true);
  assert.match(p.log(),/Directory unavailable/);
  assert.equal(p.nodes.get('active-node-summary').textContent,'DIRECTORY UNAVAILABLE');
  assert.match(p.nodes.get('minimal-nodes-list').textContent,/SyntheticDevice/);
  await p.refresh();
  assert.equal(p.nodes.get('active-node-summary').textContent,'1 ACCOUNT RECORDS');
  assert.match(p.nodes.get('minimal-nodes-list').textContent,/SyntheticDevice/);
});
test('logout transport failure never claims server signout succeeded',async()=>{
  const p=await page(()=>json({result:{}}));
  p.failLogout();
  await p.cmd('signout');
  assert.match(p.log(),/sign-out.*unconfirmed|logout.*uncertain|not confirmed/i);
  assert.doesNotMatch(p.log(),/local portal session ended/i);
  assert.equal(p.nodes.get('tp-auth-action').textContent,'[ Sign in with approved OAuth ]');
});

test('OAuth sign-in accepts only a server-validated HTTPS destination rather than a fixed private host',async()=>{
  const safe='https://issuer.test.invalid/authorize?client_id=test-client&state=synthetic';
  const p=await page(()=>json({result:{}}),{unauthenticated:true,oauthDestination:safe});
  await p.cmd('login');
  assert.equal(p.navigated(),safe,'OAuth requests='+JSON.stringify(p.requests)+' logs='+p.log());
  const unsafe=await page(()=>json({result:{}}),{
    unauthenticated:true,oauthDestination:'http://attacker.test.invalid/authorize'
  });
  await unsafe.cmd('login');
  assert.equal(unsafe.navigated(),null,'cleartext authorization destinations must be rejected');
});
