import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { ExactPortal } from '../server.mjs';

// A missing feature falls back to the existing server so RED is an actual HTTP
// behavior failure (404 versus the required contract), not an import error.
const module = await import('../oauth.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('oauth.mjs')) return {};
  throw e;
});
const Portal = module.OAuthPortal || ExactPortal;
const issuer = 'https://identity.example/';
const relayUrl = 'https://relay.example';
const resource = relayUrl + '/mcp';
const json = value => new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});
async function unusedPort() {
  const s = createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}
async function setup(t, change = {}) {
  const port = await unusedPort();
  let clock = Date.now(); const calls = []; let holdToken = null;
  const config = {issuer, resource, clientId:'approved-test-client', redirectUri:`http://127.0.0.1:${port}/oauth/callback`, scope:'tetherplane:access'};
  const fetchImpl = async (url, options = {}) => {
    calls.push({url, method:options.method || 'GET', headers:options.headers, body:options.body});
    assert.equal(options.redirect, 'error', 'credential-bearing requests must reject redirects');
    if(url === issuer + '.well-known/openid-configuration') return json({issuer, authorization_endpoint:issuer+'auth', token_endpoint:issuer+'token', code_challenge_methods_supported:['S256'], response_types_supported:['code'], grant_types_supported:['authorization_code'], token_endpoint_auth_methods_supported:['none'], authorization_response_iss_parameter_supported:true, ...change.metadata});
    if(url === relayUrl+'/.well-known/oauth-protected-resource') return json({resource, authorization_servers:[issuer], scopes_supported:['tetherplane:access'], ...change.resourceMetadata});
    if(url === issuer+'token') {
      if (holdToken) await holdToken;
      return json({access_token:'synthetic-approved-token', token_type:'Bearer', expires_in:300, scope:'tetherplane:access', ...change.token});
    }
    if(url === relayUrl+'/devices') {
      assert.equal(options.headers.authorization, 'Bearer synthetic-approved-token');
      return json({devices:[{deviceId:'test-device',pairedAt:'2026-10-01T00:00:00Z',revokedAt:null}]});
    }
    throw Error('Unexpected network destination');
  };
  const portal = new Portal({relayUrl, oauth:change.disabled ? undefined : {...config, ...change.config}, htmlPath:fileURLToPath(new URL('./fixture.html',import.meta.url)), fetchImpl, now:()=>clock});
  const origin = await portal.listen(port); t.after(() => portal.close());
  async function post(path, body = {}, cookie = '', headers = {}) {
    return fetch(origin+path,{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/json','x-tetherplane-intent':'oauth',...(cookie?{cookie}:{}),...headers},body:JSON.stringify(body)});
  }
  async function start() {
    const r = await post('/api/oauth/start'); assert.equal(r.status,200);
    const data = await r.json(); const url = new URL(data.authorizationUrl);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return {r,data,url,cookie,state:url.searchParams.get('state')};
  }
  async function callback(tx, params = {}, cookie = tx.cookie) {
    const q = new URLSearchParams({state:tx.state,code:'single-use-code',iss:issuer,...params});
    return fetch(origin+'/oauth/callback?'+q,{redirect:'manual',headers:{cookie,'sec-fetch-site':'cross-site'}});
  }
  return {portal,origin,calls,post,start,callback,config,advance:n=>clock+=n,hold:p=>{holdToken=p;}};
}

test('OAuth mode is disabled without operator-supplied configuration and never accepts a pasted bearer', async t => {
  const p=await setup(t,{disabled:true});
  const r=await p.post('/api/oauth/start'); assert.equal(r.status,503); assert.equal(p.calls.length,0);
  assert.equal((await p.post('/api/session',{token:'arbitrary'})).status,405);
});
test('OAuth start is same-origin, explicit and POST-only', async t => {
  const p=await setup(t);
  assert.equal((await p.post('/api/oauth/start',{},'',{origin:'https://attacker.example'})).status,403);
  assert.equal((await p.post('/api/oauth/start',{},'',{'x-tetherplane-intent':''})).status,403);
  assert.equal((await fetch(p.origin+'/api/oauth/start')).status,405); assert.equal(p.calls.length,0);
});
test('start binds S256, exact client/callback/resource and a browser-specific HttpOnly cookie', async t => {
  const p=await setup(t); const tx=await p.start();
  assert.equal(tx.url.origin,new URL(issuer).origin);
  for(const [k,v] of Object.entries({client_id:p.config.clientId,redirect_uri:p.config.redirectUri,resource,scope:'tetherplane:access',response_type:'code',code_challenge_method:'S256'})) assert.equal(tx.url.searchParams.get(k),v);
  assert.match(tx.state,/^[A-Za-z0-9_-]{43}$/); assert.match(tx.url.searchParams.get('code_challenge'),/^[A-Za-z0-9_-]{43}$/);
  assert.match(tx.r.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  assert.ok(!JSON.stringify(tx.data).includes('code_verifier'));
  assert.ok(!p.calls.some(c=>c.method!=='GET'));
});
test('issuer mismatch and cross-origin metadata endpoints fail before authorization', async t => {
  for(const metadata of [{issuer:'https://evil.example/'},{token_endpoint:'https://evil.example/token'},{code_challenge_methods_supported:['plain']},{authorization_response_iss_parameter_supported:false}]) {
    const p=await setup(t,{metadata}); assert.equal((await p.post('/api/oauth/start')).status,503); assert.equal(p.portal.sessions.size,0);
  }
});
test('resource metadata cannot widen the authorization server or resource', async t => {
  for(const resourceMetadata of [{resource:relayUrl+'/other'},{authorization_servers:[issuer,'https://evil.example/']},{scopes_supported:[]}]) {
    const p=await setup(t,{resourceMetadata}); assert.equal((await p.post('/api/oauth/start')).status,503);
  }
});
test('wrong browser cookie, wrong state and duplicate callback parameters never exchange a code', async t => {
  const p=await setup(t);const tx=await p.start();
  assert.equal((await p.callback(tx,{},'')).status,400);
  assert.equal((await p.callback(tx,{state:'wrong'})).status,400);
  const q=new URLSearchParams({state:tx.state,code:'first',iss:issuer});q.append('code','second');
  assert.equal((await fetch(p.origin+'/oauth/callback?'+q,{headers:{cookie:tx.cookie}})).status,400);
  assert.ok(!p.calls.some(c=>c.url===issuer+'token')); assert.equal(p.portal.sessions.size,0);
});
test('wrong response issuer, denied authorization and expired transactions fail closed', async t => {
  for(const kind of ['issuer','denied','expired']) {
    const p=await setup(t); const tx=await p.start();
    if(kind==='expired') p.advance(300001);
    const params=kind==='issuer'?{iss:'https://evil.example/'}:kind==='denied'?{error:'access_denied',code:''}:{};
    assert.equal((await p.callback(tx,params)).status,400);
    assert.ok(!p.calls.some(c=>c.url===issuer+'token')); assert.equal(p.portal.sessions.size,0);
  }
});
test('code exchange establishes account-validated short-lived session, without returning the bearer', async t => {
  const p=await setup(t);const tx=await p.start();const response=await p.callback(tx);
  assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/');
  const tokens=p.calls.filter(c=>c.url===issuer+'token');assert.equal(tokens.length,1);
  const form=new URLSearchParams(tokens[0].body);
  assert.equal(form.get('grant_type'),'authorization_code');assert.equal(form.get('code'),'single-use-code');
  assert.equal(form.get('redirect_uri'),p.config.redirectUri);assert.equal(form.get('resource'),resource);
  assert.equal(form.get('client_id'),p.config.clientId);assert.equal(form.has('client_secret'),false);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),tx.url.searchParams.get('code_challenge'));
  const cookies=response.headers.getSetCookie();const sessionCookie=cookies.find(c=>c.startsWith(p.portal.cookieName+'='));
  assert.ok(sessionCookie);assert.match(sessionCookie,/HttpOnly; SameSite=Strict/);assert.match(sessionCookie,/Max-Age=300/);
  assert.ok(!cookies.join('').includes('synthetic-approved-token'));
  const session=await fetch(p.origin+'/api/session',{headers:{cookie:sessionCookie.split(';')[0]}});
  assert.equal(session.status,200);assert.ok(!(await session.text()).includes('synthetic-approved-token'));
  assert.equal((await p.callback(tx)).status,400); assert.equal(p.calls.filter(c=>c.url===issuer+'token').length,1);
  p.advance(300001);assert.equal((await fetch(p.origin+'/api/session',{headers:{cookie:sessionCookie.split(';')[0]}})).status,401);
});
test('cancellation invalidates a pending callback without contacting the issuer', async t => {
  const p=await setup(t);const tx=await p.start();assert.equal((await p.post('/api/oauth/cancel',{},tx.cookie)).status,200);
  assert.equal((await p.callback(tx)).status,400);assert.ok(!p.calls.some(c=>c.url===issuer+'token'));
});
test('cancellation during token exchange prevents a late authenticated session', async t => {
  const p=await setup(t);const tx=await p.start();let release;const gate=new Promise(r=>{release=r;});p.hold(gate);
  const waiting=p.callback(tx);t.after(()=>release());
  for(let i=0;i<100&&!p.calls.some(c=>c.url===issuer+'token');i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(p.calls.some(c=>c.url===issuer+'token'));
  await p.post('/api/oauth/cancel',{},tx.cookie);release();assert.equal((await waiting).status,400);assert.equal(p.portal.sessions.size,0);
});
test('invalid token type, expiry or expanded scope cannot establish a local session', async t => {
  for(const token of [{token_type:'Basic'},{expires_in:0},{expires_in:Infinity},{scope:'tetherplane:access admin'},{access_token:'bad\r\ntoken'}]) {
    const p=await setup(t,{token});const tx=await p.start();assert.equal((await p.callback(tx)).status,400);assert.equal(p.portal.sessions.size,0);
  }
});
test('cross-site navigation to the public portal is allowed without relaxing API boundaries', async t => {
  const p=await setup(t);
  const page=await fetch(p.origin+'/',{headers:{'sec-fetch-site':'cross-site'}});
  assert.equal(page.status,200);
  assert.equal((await fetch(p.origin+'/api/session',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await fetch(p.origin+'/tp-integration.js',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await fetch(p.origin+'/',{headers:{host:'localhost:'+new URL(p.origin).port}})).status,403);
  assert.equal((await fetch(p.origin+'/',{headers:{origin:'https://attacker.example'}})).status,403);
});

test('OAuth mode serves the original document and extends behavior without changing visual source', async t => {
  const p=await setup(t);const raw=await readFile(new URL('./fixture.html',import.meta.url),'utf8');
  const served=await (await fetch(p.origin)).text();assert.equal(served.replace('<script src="/tp-integration.js" defer></script>\n',''),raw);
  const js=await (await fetch(p.origin+'/tp-integration.js')).text();assert.ok(js.includes('/api/oauth/start'));
  const original=await readFile(new URL('../public/tp-integration.js',import.meta.url),'utf8');assert.ok(js.startsWith(original));
});
