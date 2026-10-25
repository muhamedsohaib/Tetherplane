import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const pin='4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8';

test('approved owner HTML fingerprint agrees across installer, verifier and integration contract',async()=>{
  const [installer,verifier,contract]=await Promise.all([
    readFile(new URL('../scripts/Install-ApprovedHtml.ps1',import.meta.url),'utf8'),
    readFile(new URL('../tools/verify-original.mjs',import.meta.url),'utf8'),
    readFile(new URL('./integration.test.mjs',import.meta.url),'utf8'),
  ]);
  for(const [name,source] of [['installer',installer],['verifier',verifier],['contract',contract]]){
    assert.ok(source.toLowerCase().includes(pin),name+' has an outdated checksum gate');
  }
  const file=new URL('../public/index.html',import.meta.url);
  try{await stat(file);}catch(e){if(e.code==='ENOENT')return;throw e;}
  const actual=createHash('sha256').update(await readFile(file)).digest('hex');
  assert.equal(actual,pin,'owner-provided bytes changed');
});
