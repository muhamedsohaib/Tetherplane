// Operator-only one-time initialization. This is NOT a runtime auto-repair tool.
// Never use on an existing production deployment without a reviewed recovery plan.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {provisionAuthorityAudit} from '../authority-audit.mjs';

export async function provisionFromPrivateConfig(filename){
  const raw=await readFile(resolve(filename));
  if(raw.length>16384)throw Error('Configuration too large.');
  const config=JSON.parse(raw.toString('utf8'));
  if(!config||typeof config!=='object'||Array.isArray(config))
    throw Error('Invalid private authority configuration.');
  return provisionAuthorityAudit(config);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==4||process.argv[2]!=='--authority-config')
      throw Error('Requires --authority-config <private-json-path>.');
    await provisionFromPrivateConfig(process.argv[3]);
    console.log('PRIVATE_AUTHORITY_AUDIT_INITIALIZED=YES');
    console.log('Existing journals and checkpoints are never overwritten.');
  }catch{
    // No error detail: filesystem paths and private configuration remain private.
    console.error('Audit initialization refused. Preserve existing files and review the private configuration.');
    process.exitCode=1;
  }
}
