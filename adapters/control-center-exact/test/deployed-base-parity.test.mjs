import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// Production receipt verified by the owner, 2026-10-25. This is a compatibility
// fingerprint, not a deployed-secret or a replacement for live acceptance.
// The reference server itself stays out of the repository.
const deployedSha='aa6bdab77879780aa5bf3164aba1a2b51d50df8b117fa74e68221d84cf7353b8';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

test('reversing only the Device Authority hook reconstructs the exact deployed VAULTER server',async()=>{
  let bytes=await readFile(new URL('../server.mjs',import.meta.url));
  const changes=[
    [
      Buffer.from("import { AuthorityError } from './authority.mjs';\r\n"),
      Buffer.alloc(0)
    ],
    [
      Buffer.from("        if(this.authority){\n"+
        "          if(!body.device)throw err(403,'portal_authority_denied','An explicit paired device is required.');\n"+
        "          this.authority.enforceVerified(session.token,body.device,body.tool,body.op);\n"+
        "        }\n"),
      Buffer.alloc(0)
    ],
    [
      Buffer.from('fail(res,e instanceof AuthorityError?err(e.status,e.code,e.message):e);'),
      Buffer.from('fail(res,e);')
    ],
    [
      Buffer.from("import { createServer } from 'node:http';\n"),
      Buffer.from("import { createServer } from 'node:http';\r\n")
    ]
  ];
  for(const [oldBytes,newBytes] of changes){
    const position=bytes.indexOf(oldBytes);
    assert.notEqual(position,-1,'expected single minimal authority change missing');
    assert.equal(bytes.indexOf(oldBytes,position+oldBytes.length),-1,
      'ambiguous authority change: refusing to certify deployed-source parity');
    bytes=Buffer.concat([bytes.subarray(0,position),newBytes,bytes.subarray(position+oldBytes.length)]);
  }
  assert.equal(bytes.length,20808,'deployed source length differs');
  assert.equal(sha(bytes),deployedSha,
    'production source drift: reconcile the actual deployed base before release');
});
