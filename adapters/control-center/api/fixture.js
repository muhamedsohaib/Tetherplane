/**
 * VISUAL QA ONLY. No relay access, authentication, credential storage or device writes.
 * Serve the original, unmodified PR #22 public/ UI against labeled synthetic records.
 * Never use these routes with actual Tetherplane credentials or in production.
 */
const noopHeaders = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Tetherplane-Fixture': 'synthetic-no-relay',
};
const supported = Object.freeze({
  session:['GET','POST'],
  devices:['GET'],
  logout:['POST'],
  pair:['POST'],
  revoke:['POST'],
});
function directory(){
  const now = Date.now();
  return {
    devices:[
      {deviceId:'preview-example-01',pairedAt:'2026-10-19T12:45:00.000Z',revokedAt:null},
      {deviceId:'preview-example-02',pairedAt:'2026-10-19T13:00:00.000Z',revokedAt:'2026-10-19T14:00:00.000Z'},
    ],
    csrfToken:'VISUAL_PREVIEW_NOT_A_CREDENTIAL',
    expiresAt:new Date(now+15*60_000).toISOString(),
    observedAt:new Date(now).toISOString(),
  };
}
export default function handler(req,res){
  for(const [name,value] of Object.entries(noopHeaders))res.setHeader(name,value);
  const action=String(req.query?.action ?? '');
  const allowed=supported[action];
  if(!allowed)return res.status(404).json({error:{message:'Not a preview fixture route.'}});
  if(!allowed.includes(req.method))return res.status(405).json({error:{message:'Method not allowed.'}});
  if(action==='pair'||action==='revoke')return res.status(403).json({error:{message:'Visual preview only. No device or relay operation can be performed.'}});
  if(action==='logout')return res.status(200).json({signedOut:true});
  if(action==='session' && req.method==='POST'){
    const token=req.body && typeof req.body==='object' ? req.body.token : undefined;
    if(token!=='PREVIEW')return res.status(403).json({error:{message:'Visual preview only: enter PREVIEW, never a real credential.'}});
  }
  return res.status(200).json(directory());
}
