import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// Owner-confirmed VAULTER production source SHA. Original deployed server uses
// CRLF. Git's Windows checkout may convert the five LF-only authority insertions
// to CRLF. Normalize ONLY line endings, reverse exactly three known authority
// edits, then reconstruct the original CRLF bytes for an exact SHA-256 match.
const deployedSha='aa6bdab77879780aa5bf3164aba1a2b51d50df8b117fa74e68221d84cf7353b8';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('reverting only the Device Authority hook reconstructs exact deployed VAULTER bytes after Windows checkout',async()=>{
  let source=(await readFile(new URL('../server.mjs',import.meta.url))).toString('utf8').replace(/\r\n/g,'\n');
  const changes=[
    ["import { AuthorityError } from './authority.mjs';\n",''],
    ["        if(this.authority){\n"+
      "          if(!body.device)throw err(403,'portal_authority_denied','An explicit paired device is required.');\n"+
      "          this.authority.enforceVerified(session.token,body.device,body.tool,body.op);\n"+
      "        }\n",''],
    ['fail(res,e instanceof AuthorityError?err(e.status,e.code,e.message):e);','fail(res,e);']
  ];
  for(const [oldText,newText] of changes){
    const first=source.indexOf(oldText);
    assert.notEqual(first,-1,'required authority-only change missing');
    assert.equal(source.indexOf(oldText,first+oldText.length),-1,
      'ambiguous authority edit; unable to certify production-source parity');
    source=source.slice(0,first)+newText+source.slice(first+oldText.length);
  }
  const reconstructed=Buffer.from(source.replace(/\n/g,'\r\n'),'utf8');
  assert.equal(reconstructed.length,20808,'production source byte count changed');
  assert.equal(sha(reconstructed),deployedSha,
    'production source drift: reviewed VAULTER base no longer reconstructs exactly');
});
