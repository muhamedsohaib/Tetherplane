// Read-only device access evidence. Never infer a caller grant from device.capabilities.
export const PROBES=Object.freeze({
  device_status: Object.freeze({namespace:'device',tool:'device',operation:'status'}),
  browser_status: Object.freeze({namespace:'browser',tool:'browser',operation:'status'}),
  filesystem_info: Object.freeze({namespace:'filesystem',tool:'files',operation:'info'}),
  process_echo: Object.freeze({namespace:'process',tool:'process',operation:'run'})
});
const GROUPS=new Set(['filesystem','process','browser','desktop','batch']);
const REQUESTABLE=Object.freeze({
  filesystem:Object.freeze(['info','list','read','read_many','write','append','mkdir','move','patch']),
  process:Object.freeze(['run','read','input','list_sessions','list_system','terminate']),
  browser:Object.freeze(['status','pages','create_tab','navigate','act']),
  desktop:Object.freeze(['snapshot','act']),
  batch:Object.freeze(['execute'])
});
const SAFE_OP=/^[a-z][a-z0-9_]{0,63}$/;
const SAFE_DIR=/^[A-Za-z]:\\[^<>:"|?*\x00-\x1f]{2,245}$/;
const VALID_ACTION=new Set(['grant','revoke']);
export function portalDenied(namespace,denied){
  if(namespace==='process'||namespace==='batch')return denied.length>0;
  return denied.includes(namespace)||(namespace==='browser'&&denied.includes('filesystem'));
}
export function effectiveInventory(providers,denied){
  return providers.map(p=>({
    namespace:p.namespace,
    operations:[...p.operations],
    providerAvailable:p.available,
    portalRestricted:portalDenied(p.namespace,denied),
    access:!p.available?'provider_unavailable':
      !p.operations.length?'no_operations_advertised':
      portalDenied(p.namespace,denied)?'portal_restricted':'not_verified',
    requestableOperations:p.available?(REQUESTABLE[p.namespace]||[]):[],
    evidence:'advertised_inventory_only'
  }));
}
export function checkedProbe(probe,path){
  const spec=PROBES[probe];
  if(!spec)throw Error('Unsupported access probe');
  if(probe==='filesystem_info'){
    if(typeof path!=='string'||path.length>260||!SAFE_DIR.test(path)||path.split(/[\\/]/).includes('..'))
      throw Error('Supply a specific absolute Windows path without parent traversal');
  }else if(path!==undefined&&path!==null&&path!=='')throw Error('Unexpected path for this probe');
  return {spec,args:probe==='filesystem_info'?{path}:
    probe==='process_echo'?{program:'cmd.exe',args:['/d','/c','echo TETHERPLANE_PORTAL_ACCESS_PROBE']}:{}};
}
export function classifyProbeReply(probe,result){
  const raw=result?.structuredContent;
  const code=raw?.error?.code||raw?.code||raw?.data?.error?.code;
  if(code==='permission_denied'||code==='portal_authority_denied')return 'denied';
  if(result?.isError===true||raw?.status==='error'||!raw||typeof raw!=='object')return 'not_verified';
  if(probe==='device_status'&&
    (typeof raw.agent_version!=='string'||typeof raw.policy_mode!=='string'))return 'not_verified';
  if(probe==='process_echo'&&
    (raw.exit_code!==0||typeof raw.stdout!=='string'||!raw.stdout.includes('TETHERPLANE_PORTAL_ACCESS_PROBE')))
    return 'not_verified';
  return 'verified_allowed';
}
export function localReviewFields({intent,capability,directory,reason,confirmDeviceId,deviceId,providers}){
  if(!VALID_ACTION.has(intent))throw Error('Select grant or revoke');
  if(confirmDeviceId!==deviceId)throw Error('Exact device name confirmation required');
  if(typeof reason!=='string'||reason.trim().length<8||reason.length>200||/[\x00-\x1f\x7f]/.test(reason))
    throw Error('Provide a specific 8-200 character reason');
  if(typeof capability!=='string'||!/^([a-z]+)\.([a-z][a-z0-9_]*)$/.test(capability))
    throw Error('Choose an exact advertised operation');
  const [group,op]=capability.split('.');
  const p=providers.find(x=>x.namespace===group);
  if(!GROUPS.has(group)||!p?.available||!REQUESTABLE[group]?.includes(op)||!SAFE_OP.test(op))
    throw Error('The device provider is unavailable or this exact operation is not supported by the review catalog');
  if(group==='filesystem'){
    if(typeof directory!=='string'||directory.length>260||!SAFE_DIR.test(directory)||
      directory.split(/[\\/]/).includes('..')||/^[A-Za-z]:\\?$/.test(directory))
      throw Error('Filesystem requests require an exact, non-root Windows directory');
  }else if(directory!==null&&directory!==''&&directory!==undefined)
    throw Error('A directory can only be requested for filesystem capabilities');
  return {intent,capability,directory:group==='filesystem'?directory:null,reason:reason.trim(),
    advertisedByAgent:p.operations.includes(op)};
}
