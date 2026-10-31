// Additive V5 owner portal bridge. It does not modify V5 authority/audit
// files or handle device-local policy. Relay still authenticates the bearer
// and verifies the exact owner identity before any mutation.
const ALLOWED = new Map([
  ["/api/owner-leno", {method:"GET",upstream:"/owner/leno"}],
  ["/api/owner-leno/grant", {method:"POST",upstream:"/owner/leno/grant"}],
  ["/api/owner-leno/enforcement", {method:"POST",upstream:"/owner/leno/enforcement"}],
]);
const json=(res,status,value)=>{
  if(res.writableEnded||res.destroyed)return;
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
  res.end(JSON.stringify(value));
};
const fields=(obj,keys)=>Object.keys(obj).length===keys.length
  && Object.keys(obj).every(key=>keys.includes(key));
class ProxyError extends Error {
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}
async function bodyObject(req) {
  let size=0;const parts=[];
  for await(const chunk of req){
    size+=chunk.length;
    if(size>4096)throw new ProxyError(413,"body_too_large","Owner action exceeds request limit");
    parts.push(Buffer.from(chunk));
  }
  let body;
  try{body=JSON.parse(Buffer.concat(parts).toString("utf8"));}
  catch{throw new ProxyError(400,"invalid_request","Invalid owner action body");}
  if(!body||typeof body!=="object"||Array.isArray(body))
    throw new ProxyError(400,"invalid_request","Owner action requires a JSON object");
  return body;
}

export class OwnerLenoPortalProxy {
  constructor(portal) {this.portal=portal;}
  async handle(req,res) {
    try {
      if(!this.portal.authority)
        throw new ProxyError(503,"owner_authority_unavailable","Owner management is not configured");
      if(!this.portal.origin || req.headers.host!==new URL(this.portal.origin).host ||
        req.headers["sec-fetch-site"]==="cross-site" ||
        (req.headers.origin&&req.headers.origin!==this.portal.origin))
        throw new ProxyError(403,"origin_denied","Owner actions require the current local Control Center");
      const allowed=ALLOWED.get(req.url);
      if(!allowed)throw new ProxyError(404,"not_found","Unknown owner action");
      if(req.method!==allowed.method)
        throw new ProxyError(405,"method_not_allowed","Owner action method not supported");
      const {session}=this.portal.session(req);
      // The accepted V5 editor enrollment remains a separate strict gate.
      // checkedActor first authenticates this existing token with the relay
      // and verifies that Leno belongs to the current account.
      const registry=this.portal.authority.registry;
      const actor=await registry.checkedActor(session.token,"Leno");
      if(!registry.adminSubjects.has(actor.sub))
        throw new ProxyError(403,"owner_approval_required","Only the enrolled owner editor may manage Leno grants");
      let body=null;
      if(req.method==="POST") {
        if(req.headers.origin!==this.portal.origin ||
           !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"]||""))
          throw new ProxyError(403,"origin_denied","Same-origin JSON owner action required");
        this.portal.requireCsrf(req,session);
        this.portal.authority.limitMutations();
        body=await bodyObject(req);
        if(req.url==="/api/owner-leno/grant") {
          if(!fields(body,["revision","clientId","principalId","confirmation"]) ||
             body.confirmation!=="TRUST Leno")
            throw new ProxyError(400,"confirmation_required","Exact Leno grant confirmation required");
        } else if(!fields(body,["revision","enabled","confirmation"]) ||
           !["ENFORCE Leno GRANTS","RESTORE Leno LEGACY ACCESS"].includes(body.confirmation)) {
          throw new ProxyError(400,"confirmation_required","Exact Leno enforcement confirmation required");
        }
      }
      const result=await this.portal.relay(allowed.upstream,session.token,allowed.method,body);
      if(!result || typeof result!=="object" || !Number.isSafeInteger(result.revision) && req.method==="POST")
        throw new ProxyError(502,"invalid_relay_response","Owner policy update was not confirmed");
      json(res,200,result);
    } catch(e) {
      const trusted=e instanceof ProxyError || (
        Number.isInteger(e?.status) && ["origin_denied","owner_approval_required",
        "authentication_required","csrf_denied","permission_denied","invalid_request",
        "relay_unavailable","rate_limited"].includes(e?.code));
      const status=trusted?e.status:503;
      json(res,status,{error:{code:trusted?e.code:"owner_action_unverified",
        message:trusted?e.message:"Owner action outcome is unknown; refresh the current policy before retrying"}});
    }
  }
}
