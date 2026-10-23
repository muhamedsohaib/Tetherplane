import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const defaultHtmlPath = resolve(root, 'public/index.html');
const clientPath = resolve(root, 'public/tp-integration.js');
const VALID_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VALID_CODE = /^[A-F0-9]{4}-[A-F0-9]{4}$/;
const VALID_TOOLS = new Set(['device','files','process','browser','desktop','batch']);
const VALID_OPERATIONS = /^[a-z][a-z0-9_]{0,63}$/;
const TTL = 15 * 60_000;

export class PortalError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
const err = (status,code,message) => new PortalError(status,code,message);
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function secureOrigin(url) {
  const u = new URL(url);
  if(u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
    (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(u.hostname))))
      throw new Error('Relay origin must be HTTPS or numeric loopback HTTP for isolated development.');
  return u.origin;
}
function cappedString(x, max=200) {return typeof x==='string' && x.length<=max;}
function constantEqual(a,b) {
  if(typeof a!=='string' || typeof b!=='string')return false;
  const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length&&timingSafeEqual(x,y);
}
function send(res,status,payload,extra={}) {
  if(res.writableEnded)return;
  res.writeHead(status,{'content-type':'application/json; charset=utf-8',...extra});res.end(JSON.stringify(payload));
}
function fail(res,e) {
  const x=e instanceof PortalError ? e : err(500,'internal_error','Portal operation failed.');
  send(res,x.status,{error:{code:x.code,message:x.message}});
}
async function readBody(req,limit=24*1024) {
  const chunks=[];let len=0;
  try {
    for await(const b of req) {len+=b.length;if(len>limit)throw err(413,'body_too_large','Request exceeded permitted size.');chunks.push(b);}
    const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!obj(parsed))throw Error('not object');return parsed;
  } catch(e) {if(e instanceof PortalError)throw e;throw err(400,'invalid_request','A valid JSON object is required.');}
}
function safeHeaders(res) {
  res.setHeader('cache-control','no-store');
  res.setHeader('x-frame-options','DENY');
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','no-referrer');
  res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=(), payment=()');
  // The supplied exact HTML has inline event handlers and CSS; CSP cannot disallow
  // them without changing the user's immutable source. This is a local-only preview.
  res.setHeader('content-security-policy',"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
}
function getCookie(header,name){const found=(header||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));return found.length===1?found[0].slice(name.length+1):null;}
function deviceView(raw){
  if(!obj(raw)||!cappedString(raw.deviceId,128)||!VALID_ID.test(raw.deviceId)||!cappedString(raw.pairedAt,40)||!Number.isFinite(Date.parse(raw.pairedAt))||!(raw.revokedAt===null||(cappedString(raw.revokedAt,40)&&Number.isFinite(Date.parse(raw.revokedAt)))))
    throw err(502,'invalid_relay_response','Relay returned an invalid device record.');
  const presence = raw.connectivity === 'relay_connected' || raw.connectivity === 'relay_disconnected' ? raw.connectivity : 'not_reported';
  return {deviceId:raw.deviceId,pairedAt:raw.pairedAt,revokedAt:raw.revokedAt,connectivity:presence,version:null};
}

export class ExactPortal {
  constructor({relayUrl, now=Date.now, fetchImpl=fetch, htmlPath=defaultHtmlPath}={}) {
    this.relayOrigin=secureOrigin(relayUrl);this.now=now;this.fetch=fetchImpl;this.htmlPath=resolve(htmlPath);
    this.sessions=new Map();this.loginCount=0;this.loginWindow=0;
    this.pairCount=0;this.pairWindow=0;
    this.server=createServer({requestTimeout:12000,headersTimeout:5000,maxHeaderSize:16384},(req,res)=>{void this.handle(req,res);});
    this.origin='';this.cookieName='';
  }
  async listen(port=8790) {
    if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
    // Fail at startup if the user's original, explicitly supplied HTML is absent.
    await readFile(this.htmlPath);
    await new Promise((ok,fail)=>{this.server.once('error',fail);this.server.listen(port,'127.0.0.1',()=>{this.server.off('error',fail);ok();});});
    const p=this.server.address().port;this.origin=`http://127.0.0.1:${p}`;this.cookieName=`tetherplane_exact_${p}`;return this.origin;
  }
  async close() {this.sessions.clear();await new Promise((ok,fail)=>this.server.close(e=>e?fail(e):ok()));}
  prune(){for(const [id,s] of this.sessions)if(s.expires<=this.now())this.sessions.delete(id);}
  limit(kind,count){const now=this.now(), win=kind==='login'?'loginWindow':'pairWindow',num=kind==='login'?'loginCount':'pairCount';if(now-this[win]>=60000){this[win]=now;this[num]=0;}if(++this[num]>count)throw err(429,'rate_limited','Too many attempts. Retry later.');}
  session(req){const id=getCookie(req.headers.cookie,this.cookieName);const session=id&&this.sessions.get(id);if(!session||session.expires<=this.now()){if(id)this.sessions.delete(id);throw err(401,'authentication_required','Sign in using an authorized relay access credential.');}return {id,session};}
  requireCsrf(req,s){if(!constantEqual(req.headers['x-csrf-token'],s.csrf))throw err(403,'csrf_denied','Your session could not authorize this request.');}
  async relay(path,token,method='GET',body=null){
    let response;
    try{response=await this.fetch(this.relayOrigin+path,{method,redirect:'error',signal:AbortSignal.timeout(6500),headers:{authorization:`Bearer ${token}`,accept:'application/json',...(body===null?{}:{'content-type':'application/json'})},...(body===null?{}:{body:JSON.stringify(body)})});}
    catch{throw err(502,'relay_unavailable','The relay could not be reached. Do not retry an uncertain mutation without refreshing.');}
    if(response.status===401){await response.body?.cancel();throw err(401,'authentication_required','Relay authorization expired or was rejected.');}
    if(response.status===403){await response.body?.cancel();throw err(403,'permission_denied','The relay denied this action.');}
    if(response.status===409){await response.body?.cancel();throw err(409,'conflict','Owner authority changed. Refresh before editing.');}
    if(response.status===404 && path.startsWith('/authority')){await response.body?.cancel();throw err(503,'authority_unavailable','Owner access management is not configured on this relay.');}
    if(!response.ok){await response.body?.cancel();if(path==='/pair/approve'&&response.status===400)throw err(400,'pairing_rejected','The code is invalid, expired or already consumed. Check the authorized device before trying again.');throw err(502,'relay_unavailable','Relay rejected the request. Confirm the current state before retrying.');}
    if(!(response.headers.get('content-type')||'').toLowerCase().startsWith('application/json')){await response.body?.cancel();throw err(502,'invalid_relay_response','Unsupported relay response.');}
    const raw=await this.readResponse(response,512*1024);
    try{return JSON.parse(raw);}catch{throw err(502,'invalid_relay_response','Invalid relay JSON response.');}
  }
  async readResponse(response,maxBytes){
    let size=0;const chunks=[];
    if(!response.body)throw err(502,'invalid_relay_response','Missing relay response.');
    try{for await(const chunk of response.body){size+=chunk.length;if(size>maxBytes){await response.body.cancel().catch(()=>{});throw err(502,'invalid_relay_response','Relay output exceeds configured limit.');}chunks.push(Buffer.from(chunk));}}
    catch(e){if(e instanceof PortalError)throw e;throw err(502,'relay_unavailable','Relay response was interrupted.');}
    return Buffer.concat(chunks).toString('utf8');
  }
  async directory(token){const payload=await this.relay('/devices',token);if(!obj(payload)||!Array.isArray(payload.devices)||payload.devices.length>1000)throw err(502,'invalid_relay_response','Invalid relay directory response.');const seen=new Set();return payload.devices.map(d=>{const parsed=deviceView(d);if(seen.has(parsed.deviceId))throw err(502,'invalid_relay_response','Duplicate device record.');seen.add(parsed.deviceId);return parsed;});}
  view(s,devices){return {devices,csrfToken:s.csrf,expiresAt:new Date(s.expires).toISOString(),observedAt:new Date(this.now()).toISOString(),relayOrigin:this.relayOrigin,authenticated:true};}
  async mcpPost(token,body,sessionId=null,version=null) {
    let response;
    try {response=await this.fetch(this.relayOrigin+'/mcp',{method:'POST',redirect:'error',signal:AbortSignal.timeout(9000),headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream',...(sessionId?{'mcp-session-id':sessionId}:{}),...(version?{'mcp-protocol-version':version}:{})},body:JSON.stringify(body)});}
    catch{throw err(502,'mcp_unavailable','MCP relay unreachable or timed out; verify result before retrying.');}
    if(response.status===401){await response.body?.cancel();throw err(401,'authentication_required','MCP authorization rejected this credential.');}
    if(response.status===403){await response.body?.cancel();throw err(403,'permission_denied','MCP authorization denied this request.');}
    if(!response.ok){await response.body?.cancel();throw err(502,'mcp_unavailable',`MCP transport returned HTTP ${response.status}.`);}
    const sid=response.headers.get('mcp-session-id');
    if(body.method==='notifications/initialized') {await response.body?.cancel();return {sessionId:sid||sessionId,message:null};}
    const raw=await this.readResponse(response,128*1024);
    let parsed;
    const ct=(response.headers.get('content-type')||'').toLowerCase();
    if(ct.startsWith('application/json')){try{parsed=JSON.parse(raw);}catch{throw err(502,'invalid_mcp_response','Malformed MCP JSON.');}}
    else if(ct.startsWith('text/event-stream')) {
      const data=raw.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).filter(Boolean);
      for(const item of data) {try{const entry=JSON.parse(item);if(entry.id===body.id){parsed=entry;break;}}catch{}}
      if(!parsed)throw err(502,'invalid_mcp_response','Missing matching MCP response.');
    }else throw err(502,'invalid_mcp_response','Unexpected MCP media type.');
    if(!obj(parsed)||parsed.id!==body.id)throw err(502,'invalid_mcp_response','Mismatched MCP request ID.');
    if(obj(parsed.error))throw err(502,'mcp_protocol_error','MCP rejected this request.');
    if(!('result' in parsed))throw err(502,'invalid_mcp_response','Missing MCP result.');
    return {sessionId:sid||sessionId,message:parsed.result};
  }
  async closeMcpSession(token,sessionId,version) {
    if(!sessionId)return;
    // Tetherplane's Streamable HTTP relay holds sessions in memory until DELETE.
    // Best-effort cleanup also runs after denied/failed tools; no mutation is retried.
    try {
      const response=await this.fetch(this.relayOrigin+'/mcp',{
        method:'DELETE',redirect:'error',signal:AbortSignal.timeout(4000),
        headers:{authorization:`Bearer ${token}`,'mcp-session-id':sessionId,...(version?{'mcp-protocol-version':version}:{})}
      });
      await response.body?.cancel();
      if(![200,202,204,404].includes(response.status))console.warn('Tetherplane: MCP session cleanup was rejected; verify relay session lifecycle.');
    } catch {console.warn('Tetherplane: MCP session cleanup could not be confirmed.');}
  }
  async mcpCall(token,tool,op,device,args) {
    // One independent, bounded MCP session per operation; close it in all outcomes.
    const init=await this.mcpPost(token,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'tetherplane-portal',version:'0.1.0-dev'}}});
    const version=init.message?.protocolVersion;
    try {
      if(typeof version!=='string'||version.length>30)throw err(502,'invalid_mcp_response','MCP negotiation failed.');
      await this.mcpPost(token,{jsonrpc:'2.0',method:'notifications/initialized'},init.sessionId,version);
      const params={name:tool,arguments:{op,args,response_mode:'compact',...(device?{device}:{})}};
      const called=await this.mcpPost(token,{jsonrpc:'2.0',id:2,method:'tools/call',params},init.sessionId,version);
      return called.message;
    } finally {await this.closeMcpSession(token,init.sessionId,version);}
  }
  async handle(req,res){
    safeHeaders(res);let sessionId=null;
    try{
      if(!this.origin)throw err(503,'starting','Portal is not listening.');
      if(req.headers.host!==new URL(this.origin).host||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==this.origin))throw err(403,'origin_denied','Open this portal using its numeric loopback address.');
      if(!req.url?.startsWith('/')||req.url.includes('?'))throw err(404,'not_found','Not found.');
      const path=req.url;
      if(path==='/'||path==='/tp-integration.js'){
        if(req.method!=='GET'&&req.method!=='HEAD')throw err(405,'method_not_allowed','GET only.');
        const buf=await readFile(path==='/'?this.htmlPath:clientPath);
        // HTML bytes on disk remain identical to the user's uploaded exact portal.
        // The sole runtime mutation loads the integration script after the original code.
        const data=path==='/'?Buffer.from(buf.toString('utf8').replace('</body>','<script src="/tp-integration.js" defer></script>\n</body>')):buf;
        res.writeHead(200,{'content-type':path==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8'});
        res.end(req.method==='HEAD'?undefined:data);return;
      }
      const revoke=/^\/api\/devices\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/revoke$/.exec(path);
      const methods=path==='/api/session'?['GET','POST']:['/api/devices','/api/authority'].includes(path)?['GET']:path==='/api/authority/grants'?['PUT']:[ '/api/logout','/api/pair/approve','/api/mcp/call','/api/authority/enforcement'].includes(path)||revoke?['POST']:[];
      if(!methods.length)throw err(404,'not_found','Unknown endpoint.');
      if(!methods.includes(req.method))throw err(405,'method_not_allowed','Unsupported method.');
      if(req.method==='POST'||req.method==='PUT'){
        if(req.headers.origin!==this.origin)throw err(403,'origin_denied','Same-origin request required.');
        if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))throw err(415,'unsupported_media_type','JSON content type required.');
      }
      this.prune();
      sessionId=getCookie(req.headers.cookie,this.cookieName);
      if(path==='/api/session' && req.method==='POST') {
        this.limit('login',30);const body=await readBody(req);
        if(!cappedString(body.token,8192)||body.token.length<1||!/^[A-Za-z0-9._~+\/-]+=*$/.test(body.token))throw err(400,'invalid_credential','Enter an existing approved relay access credential.');
        const devices=await this.directory(body.token);
        if(this.sessions.size>=64)throw err(429,'session_limit','Too many active local sessions.');
        if(sessionId)this.sessions.delete(sessionId);
        const id=randomBytes(32).toString('base64url');const session={token:body.token,csrf:randomBytes(32).toString('base64url'),expires:this.now()+TTL};
        this.sessions.set(id,session);
        send(res,200,this.view(session,devices),{'set-cookie':`${this.cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`});return;
      }
      const {id,session}=this.session(req);sessionId=id;
      if(req.method==='POST'||req.method==='PUT')this.requireCsrf(req,session);
      if(path==='/api/logout') {this.sessions.delete(id);send(res,200,{signedOut:true},{'set-cookie':`${this.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`});return;}
      if(path==='/api/pair/approve'){
        this.limit('pair',10);const body=await readBody(req);
        if(body.confirmOwnership!==true||!cappedString(body.userCode,9)||!VALID_CODE.test(body.userCode))throw err(400,'confirmation_required','Use your authorized device code (XXXX-XXXX, hexadecimal) and confirm ownership.');
        await this.directory(session.token);
        if(!this.sessions.has(id)||session.expires<=this.now())throw err(401,'authentication_required','Session expired before approval.');
        const result=await this.relay('/pair/approve',session.token,'POST',{userCode:body.userCode});
        if(!obj(result)||!VALID_ID.test(result.deviceId||'')||typeof result.pairedAt!=='string'||result.revokedAt!==null)throw err(502,'invalid_relay_response','Unexpected pairing response.');
        send(res,200,{paired:true,deviceId:result.deviceId});return;
      }
      if(revoke){
        const body=await readBody(req);const deviceId=revoke[1];
        if(body.confirmDeviceId!==deviceId)throw err(400,'confirmation_required','Type the exact device ID before revocation.');
        const d=await this.directory(session.token);
        if(!d.some(x=>x.deviceId===deviceId&&x.revokedAt===null))throw err(403,'permission_denied','Device not actively paired to this account.');
        if(!this.sessions.has(id)||session.expires<=this.now())throw err(401,'authentication_required','Session expired before revocation.');
        const result=await this.relay(`/devices/${encodeURIComponent(deviceId)}/revoke`,session.token,'POST',{});
        if(!obj(result)||result.deviceId!==deviceId||typeof result.revokedAt!=='string')throw err(502,'invalid_relay_response','Unexpected revocation response.');
        send(res,200,{revoked:true});return;
      }
      if(path==='/api/authority'){
        const snapshot=await this.relay('/authority',session.token);
        if(!obj(snapshot)||typeof snapshot.enabled!=='boolean'||!Number.isSafeInteger(snapshot.revision)||
          !Array.isArray(snapshot.grants)||!Array.isArray(snapshot.clients)||!Array.isArray(snapshot.levels))
          throw err(502,'invalid_relay_response','Unexpected owner authority response.');
        send(res,200,snapshot);return;
      }
      if(path==='/api/authority/grants'||path==='/api/authority/enforcement'){
        const body=await readBody(req,16384);
        await this.directory(session.token);
        if(!this.sessions.has(id)||session.expires<=this.now())throw err(401,'authentication_required','Session expired before policy update.');
        const endpoint=path==='/api/authority/grants'?'/authority/grants':'/authority/enforcement';
        const method=path==='/api/authority/grants'?'PUT':'POST';
        const result=await this.relay(endpoint,session.token,method,body);
        if(!obj(result)||!Number.isSafeInteger(result.revision))
          throw err(502,'invalid_relay_response','Unverified authority revision. Refresh before proceeding.');
        send(res,200,result);return;
      }
      if(path==='/api/mcp/call'){
        const body=await readBody(req,16384);
        if(!VALID_TOOLS.has(body.tool)||!cappedString(body.op,64)||!VALID_OPERATIONS.test(body.op)||!(body.device===null||body.device===undefined||(cappedString(body.device,128)&&VALID_ID.test(body.device)))||!obj(body.args)||JSON.stringify(body.args).length>8192)
          throw err(400,'invalid_request','Use an existing MCP tool, operation, permitted device ID, and JSON arguments object.');
        const accountDevices=await this.directory(session.token); // account identity must still be valid
        if(body.device&&!accountDevices.some(d=>d.deviceId===body.device&&d.revokedAt===null))throw err(403,'permission_denied','Device is not paired to this account.');
        if(!this.sessions.has(id)||session.expires<=this.now())throw err(401,'authentication_required','Session expired before operation.');
        const result=await this.mcpCall(session.token,body.tool,body.op,body.device||undefined,body.args);
        send(res,200,{result});return;
      }
      const devices=await this.directory(session.token);
      if(!this.sessions.has(id)||session.expires<=this.now())throw err(401,'authentication_required','Session expired before refresh.');
      send(res,200,this.view(session,devices));
    }catch(e){if(e instanceof PortalError&&e.status===401&&sessionId)this.sessions.delete(sessionId);fail(res,e);}
  }
}

function parseArgs(argv){
  let relayUrl=process.env.TETHERPLANE_RELAY_URL||null,port=8790;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--relay-url')relayUrl=argv[++i];
    else if(argv[i]==='--port')port=Number(argv[++i]);
    else if(argv[i]==='--help'){console.log('Usage: node server.mjs --relay-url https://YOUR-APPROVED-RELAY [--port 8790]');process.exit(0);}
    else throw Error('Unknown option: '+argv[i]);
  }
  if(!relayUrl)throw Error('Supply existing relay origin with --relay-url.');return {relayUrl,port};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=new ExactPortal(parseArgs(process.argv.slice(2)));
  app.listen(parseArgs(process.argv.slice(2)).port).then(url=>{console.log('Control Center (local-only): '+url);}).catch(e=>{console.error(e.message);process.exitCode=1;});
  for(const name of ['SIGINT','SIGTERM'])process.on(name,()=>{void app.close().finally(()=>process.exit(0));});
}
