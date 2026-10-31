import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ExactPortal } from './server.mjs';
import { AuthorityHttp } from './authority-http.mjs';
import { OwnerLenoPortalProxy } from './owner-leno-proxy.mjs';

const TX_TTL = 300000;
const CALLBACK = '/oauth/callback';
class OAuthError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
const unavailable = () => new OAuthError(503,'oauth_unavailable','Browser sign-in requires a verified approved client and matching issuer configuration.');
const invalid = () => new OAuthError(400,'oauth_rejected','Sign-in could not be verified. Return to the portal and start a new sign-in.');
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function equal(a,b) {
  if(typeof a!=='string'||typeof b!=='string')return false;
  const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);
}
function cookie(req,name) {
  const parts=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
  return parts.length===1?parts[0].slice(name.length+1):null;
}
function reply(res,status,value,headers={}) {
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});
  res.end(JSON.stringify(value));
}
function oauthHeaders(res) {
  res.setHeader('cache-control','no-store');res.setHeader('referrer-policy','no-referrer');
  res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');
  res.setHeader('content-security-policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}
function validateConfig(raw,relayOrigin) {
  if(raw===undefined||raw===null)return null;
  if(!object(raw)||Object.keys(raw).some(k=>!['issuer','resource','clientId','redirectUri','scope'].includes(k)))throw unavailable();
  try {
    const issuer=new URL(raw.issuer),redirect=new URL(raw.redirectUri);
    if(issuer.protocol!=='https:'||issuer.username||issuer.password||issuer.search||issuer.hash||issuer.pathname!=='/'||issuer.href!==raw.issuer)throw unavailable();
    if(typeof raw.clientId!=='string'||!/^[A-Za-z0-9._~-]{1,256}$/.test(raw.clientId))throw unavailable();
    if(raw.resource!==relayOrigin+'/mcp'||!raw.resource.startsWith('https://')||raw.scope!=='tetherplane:access')throw unavailable();
    if(redirect.protocol!=='http:'||redirect.hostname!=='127.0.0.1'||redirect.username||redirect.password||redirect.search||redirect.hash||redirect.pathname!==CALLBACK||redirect.href!==raw.redirectUri||!redirect.port)throw unavailable();
    return Object.freeze({...raw});
  } catch {throw unavailable();}
}
async function emptyBody(req) {
  let size=0;const chunks=[];
  for await(const b of req){size+=b.length;if(size>1024)throw invalid();chunks.push(b);}
  try {const x=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!object(x)||Object.keys(x).length)throw invalid();}
  catch {throw invalid();}
}

// Optional browser sign-in adapter. It never registers clients, alters the issuer,
// reads device credentials, auto-approves an interaction, or refreshes a token.
export class OAuthPortal extends ExactPortal {
  constructor(options={}) {
    super(options);
    this.oauth=validateConfig(options.oauth,this.relayOrigin);
    this.authority=options.authority?new AuthorityHttp(this,options.authority):null;
    this.ownerLeno=this.authority?new OwnerLenoPortalProxy(this):null;
    this.transactions=new Map();this.oauthTimers=new Map();this.closed=false;
  }
  async listen(port=8790) {
    if(this.oauth&&this.oauth.redirectUri!==`http://127.0.0.1:${port}${CALLBACK}`)throw unavailable();
    const origin=await super.listen(port);this.txCookie=this.cookieName+'_oauth';return origin;
  }
  dropTransaction(id) {
    const entry=this.transactions.get(id);if(entry)clearTimeout(entry.timer);
    this.transactions.delete(id);
  }
  async close() {
    this.closed=true;for(const id of this.transactions.keys())this.dropTransaction(id);
    for(const timer of this.oauthTimers.values())clearTimeout(timer);this.oauthTimers.clear();
    await super.close();
  }
  clearTxCookie() {return `${this.txCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;}
  assertLive(id,entry,res) {
    if(this.closed||this.transactions.get(id)!==entry||entry.expires<=this.now()||res.destroyed)throw invalid();
  }
  async oauthJson(url,options={}) {
    let response;
    try {
      response=await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(6000),headers:{accept:'application/json',...options.headers}});
      if(!response.ok||!(response.headers.get('content-type')||'').toLowerCase().startsWith('application/json')){await response.body?.cancel();throw invalid();}
      const raw=await this.readResponse(response,96*1024);const value=JSON.parse(raw);
      if(!object(value))throw invalid();return value;
    } catch {throw invalid();}
  }
  async discover() {
    const c=this.oauth;if(!c)throw unavailable();
    try {
      const [metadata,resource]=await Promise.all([
        this.oauthJson(c.issuer+'.well-known/openid-configuration'),
        this.oauthJson(this.relayOrigin+'/.well-known/oauth-protected-resource')
      ]);
      const includes=(a,v)=>Array.isArray(a)&&a.includes(v);
      if(metadata.issuer!==c.issuer||metadata.authorization_response_iss_parameter_supported!==true||!includes(metadata.code_challenge_methods_supported,'S256')||!includes(metadata.response_types_supported,'code')||!includes(metadata.grant_types_supported,'authorization_code')||!includes(metadata.token_endpoint_auth_methods_supported,'none'))throw unavailable();
      for(const field of ['authorization_endpoint','token_endpoint']) {
        const u=new URL(metadata[field]);
        if(u.protocol!=='https:'||u.origin!==new URL(c.issuer).origin||u.username||u.password||u.search||u.hash||u.href!==metadata[field])throw unavailable();
      }
      if(resource.resource!==c.resource||!Array.isArray(resource.authorization_servers)||resource.authorization_servers.length!==1||resource.authorization_servers[0]!==c.issuer||!includes(resource.scopes_supported,c.scope))throw unavailable();
      return {authorize:metadata.authorization_endpoint,token:metadata.token_endpoint};
    } catch {throw unavailable();}
  }
  async begin(req,res) {
    if(!this.oauth)throw unavailable();
    this.limit('login',30);await emptyBody(req);
    for(const [id,e] of this.transactions)if(e.expires<=this.now())this.dropTransaction(id);
    if(this.transactions.size>=64)throw new OAuthError(429,'rate_limited','Too many pending sign-ins. Wait for expiry.');
    const metadata=await this.discover();if(res.destroyed||this.closed)throw invalid();
    if(this.transactions.size>=64)throw new OAuthError(429,'rate_limited','Too many pending sign-ins.');
    const old=cookie(req,this.txCookie);if(old)this.dropTransaction(old);
    const id=randomBytes(32).toString('base64url');
    const entry={state:randomBytes(32).toString('base64url'),verifier:randomBytes(32).toString('base64url'),expires:this.now()+TX_TTL,used:false,metadata,timer:null};
    entry.timer=setTimeout(()=>this.dropTransaction(id),TX_TTL);entry.timer.unref();this.transactions.set(id,entry);
    const c=this.oauth,url=new URL(metadata.authorize);
    for(const [key,value] of Object.entries({client_id:c.clientId,redirect_uri:c.redirectUri,response_type:'code',scope:c.scope,resource:c.resource,state:entry.state,code_challenge_method:'S256',code_challenge:createHash('sha256').update(entry.verifier).digest('base64url')}))url.searchParams.set(key,value);
    reply(res,200,{authorizationUrl:url.href},{'set-cookie':`${this.txCookie}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`});
  }
  async callback(req,res,url) {
    const id=cookie(req,this.txCookie),entry=id&&this.transactions.get(id);
    const q=url.searchParams;
    if(!this.oauth||!entry||entry.used||entry.expires<=this.now()||req.url.length>4096)throw invalid();
    for(const key of q.keys())if(q.getAll(key).length!==1)throw invalid();
    if(!equal(q.get('state'),entry.state))throw invalid();
    // Consume before any asynchronous work. Retain the claimed entry so cancellation
    // can invalidate an in-flight exchange and prevent a late session after logout.
    entry.used=true;
    try {
      if(q.get('iss')!==this.oauth.issuer||q.has('error')||!q.get('code')||!/^[\x21-\x7e]{1,2048}$/.test(q.get('code')))throw invalid();
      const form=new URLSearchParams({grant_type:'authorization_code',client_id:this.oauth.clientId,redirect_uri:this.oauth.redirectUri,resource:this.oauth.resource,code:q.get('code'),code_verifier:entry.verifier});
      const tokens=await this.oauthJson(entry.metadata.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form.toString()});
      this.assertLive(id,entry,res);
      if(typeof tokens.access_token!=='string'||tokens.access_token.length>8192||!/^[A-Za-z0-9._~+\/-]+=*$/.test(tokens.access_token)||tokens.token_type!=='Bearer'||!Number.isSafeInteger(tokens.expires_in)||tokens.expires_in<1||tokens.expires_in>86400||(tokens.scope!==undefined&&tokens.scope!==this.oauth.scope))throw invalid();
      const expires=this.now()+Math.min(tokens.expires_in,900)*1000;
      // Only the existing relay can validate the issued bearer and account binding.
      // Do not decode an unverified JWT or accept a browser identity assertion.
      await this.directory(tokens.access_token);this.assertLive(id,entry,res);
      this.prune();if(expires<=this.now()||this.sessions.size>=64)throw invalid();
      const old=cookie(req,this.cookieName);if(old)this.sessions.delete(old);
      const sessionId=randomBytes(32).toString('base64url');
      this.sessions.set(sessionId,{token:tokens.access_token,csrf:randomBytes(32).toString('base64url'),expires});
      const timer=setTimeout(()=>{this.sessions.delete(sessionId);this.oauthTimers.delete(sessionId);},Math.max(1,expires-this.now()));timer.unref();this.oauthTimers.set(sessionId,timer);
      const maxAge=Math.max(1,Math.floor((expires-this.now())/1000));
      res.writeHead(303,{'location':'/','set-cookie':[`${this.cookieName}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,this.clearTxCookie()]});res.end();
    } finally {if(this.transactions.get(id)===entry)this.dropTransaction(id);}
  }
  async handle(req,res) {
    const raw=req.url||'';
    const special=raw==='/tp-integration.js'||raw.startsWith('/api/oauth/')||(this.authority&&raw.startsWith('/api/authority/'))||(this.ownerLeno&&raw.startsWith('/api/owner-leno'))||raw.split('?')[0]===CALLBACK||(raw==='/api/session'&&req.method==='POST');
    if(!special)return super.handle(req,res);
    oauthHeaders(res);
    try {
      if(!this.origin||req.headers.host!==new URL(this.origin).host)throw new OAuthError(403,'origin_denied','Use the numeric loopback portal address.');
      const url=new URL(raw,this.origin);
      if(url.origin!==this.origin||!raw.startsWith('/')||raw.startsWith('//'))throw invalid();
      if(url.pathname===CALLBACK) {
        if(req.method!=='GET')throw new OAuthError(405,'method_not_allowed','GET callback required.');
        // The sole cross-site exception: GET callback protected by state, PKCE and
        // a separate browser-bound SameSite=Lax cookie; API origin checks stay strict.
        return await this.callback(req,res,url);
      }
      if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==this.origin))throw new OAuthError(403,'origin_denied','Same-origin request required.');
      if(url.search)throw invalid();
      if(this.ownerLeno&&raw.startsWith('/api/owner-leno'))return await this.ownerLeno.handle(req,res);
      if(raw.startsWith('/api/authority/'))return await this.authority.handle(req,res);
      if(raw==='/tp-integration.js') {
        if(!['GET','HEAD'].includes(req.method))throw new OAuthError(405,'method_not_allowed','GET only.');
        const original=await readFile(new URL('./public/tp-integration.js',import.meta.url));
        const oauth=await readFile(new URL('./public/tp-oauth.js',import.meta.url));
        const authority=this.authority?await readFile(new URL('./public/tp-authority.js',import.meta.url)):null;
        const ownerLeno=this.ownerLeno?await readFile(new URL('./public/tp-owner-leno.js',import.meta.url)):null;
        res.writeHead(200,{'content-type':'text/javascript; charset=utf-8'});res.end(req.method==='HEAD'?undefined:Buffer.concat([original,Buffer.from('\n'),oauth,...(authority?[Buffer.from('\n'),authority]:[]),...(ownerLeno?[Buffer.from('\n'),ownerLeno]:[])]));return;
      }
      if(raw==='/api/oauth/config') {
        if(req.method!=='GET')throw new OAuthError(405,'method_not_allowed','GET only.');
        reply(res,200,{configured:!!this.oauth});return;
      }
      if(raw==='/api/session')throw new OAuthError(405,'browser_sign_in_required','This entrypoint accepts browser OAuth only, not pasted credentials.');
      if(!['/api/oauth/start','/api/oauth/cancel'].includes(raw))throw new OAuthError(404,'not_found','Unknown OAuth endpoint.');
      if(req.method!=='POST')throw new OAuthError(405,'method_not_allowed','POST required.');
      if(req.headers.origin!==this.origin||req.headers['x-tetherplane-intent']!=='oauth')throw new OAuthError(403,'origin_denied','Explicit same-origin sign-in action required.');
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))throw new OAuthError(415,'unsupported_media_type','JSON required.');
      if(raw==='/api/oauth/start')return await this.begin(req,res);
      await emptyBody(req);const id=cookie(req,this.txCookie);if(id)this.dropTransaction(id);
      reply(res,200,{cancelled:true},{'set-cookie':this.clearTxCookie()});
    } catch(e) {
      // Never echo callback codes, tokens, raw upstream errors or request URLs.
      const failure=e instanceof OAuthError?e:invalid();
      reply(res,failure.status,{error:{code:failure.code,message:failure.message}});
    }
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let app;
  try {
    const args=process.argv.slice(2);let relayUrl,configPath,authorityConfigPath,port=8790;
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--relay-url')relayUrl=args[++i];
      else if(args[i]==='--oauth-config')configPath=args[++i];
      else if(args[i]==='--port')port=Number(args[++i]);
      else if(args[i]==='--authority-config')authorityConfigPath=args[++i];
      else throw unavailable();
    }
    let oauth;
    if(configPath){const raw=await readFile(resolve(configPath));if(raw.length>16384)throw unavailable();oauth=JSON.parse(raw.toString('utf8'));}
    let authority;
    if(authorityConfigPath){const raw=await readFile(resolve(authorityConfigPath));if(raw.length>16384)throw unavailable();authority=JSON.parse(raw.toString('utf8'));}
    app=new OAuthPortal({relayUrl,oauth,authority});const origin=await app.listen(port);
    console.log(`Control Center (local-only): ${origin}`);
    console.log(oauth?'OAuth configuration loaded; registered client approval and live acceptance remain operator gates.':'OAuth disabled: no approved configuration supplied.');
    for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void app.close().finally(()=>process.exit(0));});
  } catch {console.error('Portal did not start. Verify the approved relay, loopback callback, original HTML and OAuth configuration.');process.exitCode=1;}
}
