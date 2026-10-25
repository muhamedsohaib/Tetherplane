import {AuthorityRegistry,AuthorityError} from './authority.mjs';

const capId=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ALLOWED_POST=new Set(['change','rollback','probe','local-request']);
const err=(status,code,message)=>new AuthorityError(status,code,message);
function send(res,status,value){
  if(res.writableEnded||res.destroyed)return;
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(value));
}
async function bodyJson(req){
  const items=[];let count=0;
  try {
    for await(const chunk of req){
      count+=chunk.length;
      if(count>4096)throw err(413,'body_too_large','Authority request exceeded the size limit.');
      items.push(chunk);
    }
    const value=JSON.parse(Buffer.concat(items).toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value))
      throw err(400,'invalid_request','A JSON object is required.');
    return value;
  }catch(e){
    if(e instanceof AuthorityError)throw e;
    throw err(400,'invalid_request','A JSON object is required.');
  }
}
function exactFields(body,keys){
  const got=Object.keys(body);
  if(got.length!==keys.length||got.some(key=>!keys.includes(key)))
    throw err(400,'invalid_request','Unexpected authority request fields.');
}
export class AuthorityHttp {
  constructor(portal,config) {
    this.portal=portal;
    this.registry=new AuthorityRegistry(portal,config);
    this.lastMinute=0;this.changeCount=0;this.probeWindow=0;this.probeCount=0;
  }
  enforceVerified(token,device,tool,op){
    return this.registry.enforceVerified(token,device,tool,op);
  }
  limitMutations(){
    const now=Date.now();
    if(now-this.lastMinute>=60000){this.changeCount=0;this.lastMinute=now;}
    if(++this.changeCount>20)throw err(429,'rate_limited','Too many authority updates.');
  }
  limitProbes(){
    const now=Date.now();
    if(now-this.probeWindow>=60000){this.probeWindow=now;this.probeCount=0;}
    if(++this.probeCount>18)throw err(429,'rate_limited','Too many access checks.');
  }
  async handle(req,res) {
    try {
      if(!this.portal.origin || req.headers.host!==new URL(this.portal.origin).host ||
         req.headers['sec-fetch-site']==='cross-site'||
         (req.headers.origin && req.headers.origin!==this.portal.origin)||
         !req.url?.startsWith('/api/authority/')||req.url.includes('?')||req.url.includes('%'))
        throw err(403,'origin_denied','Authority requests must originate in the local Control Center.');
      const match=/^\/api\/authority\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\/(change|rollback|owner-proof|probe|local-request))?$/.exec(req.url);
      if(!match||!capId.test(match[1]))
        throw err(404,'not_found','Unknown authority endpoint.');
      const deviceId=match[1],operation=match[2];
      if((ALLOWED_POST.has(operation)&&req.method!=='POST')||(!operation&&req.method!=='GET')||(operation==='owner-proof'&&req.method!=='GET'))
        throw err(405,'method_not_allowed','This authority method is not supported.');
      // Always use the existing server-only OAuth session. Never accept credentials
      // directly from the browser in an authority request.
      const {session}=this.portal.session(req);
      if(operation==='owner-proof')return send(res,200,await this.registry.ownerEnrollmentProof(session.token,deviceId));
      if(operation){
        if(!ALLOWED_POST.has(operation)||req.headers.origin!==this.portal.origin)
          throw err(403,'origin_denied','An explicit same-origin owner action is required.');
        if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))
          throw err(415,'unsupported_media_type','JSON is required.');
        this.portal.requireCsrf(req,session);
        if(operation==='probe')this.limitProbes();else this.limitMutations();
        const data=await bodyJson(req);
        if(operation==='probe'){
          exactFields(data,['probe','path']);
          return send(res,200,await this.registry.verifyAccess(session.token,deviceId,data.probe,data.path));
        }
        if(operation==='local-request'){
          exactFields(data,['intent','capability','directory','confirmDeviceId','reason']);
          return send(res,200,await this.registry.localApprovalRequest(session.token,deviceId,data));
        }
        if(operation==='change'){
          exactFields(data,['denied','expectedRevision','confirmDeviceId','reason']);
          const result=await this.registry.change({token:session.token,deviceId,...data});
          return send(res,200,result);
        }
        exactFields(data,['expectedRevision','targetRevision','confirmDeviceId','reason']);
        const result=await this.registry.rollback({token:session.token,deviceId,...data});
        return send(res,200,result);
      }
      return send(res,200,await this.registry.observe(session.token,deviceId));
    }catch(e){
      const safe=(e instanceof AuthorityError||Number.isInteger(e?.status)&&typeof e.code==='string');
      send(res,safe?e.status:503,{error:{
        code:safe?e.code:'authority_unavailable',
        message:safe?e.message:'Authority outcome is uncertain. Refresh the verified audit before any further change.'
      }});
    }
  }
}
