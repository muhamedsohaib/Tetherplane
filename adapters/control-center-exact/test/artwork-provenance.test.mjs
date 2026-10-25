import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const pin='4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8';
const fontPin='18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e';

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


test('private font fingerprint and Git exclusion remain enforced when local asset is present',async()=>{
  const [ignore,verifier]=await Promise.all([
    readFile(new URL('../public/.gitignore',import.meta.url),'utf8'),
    readFile(new URL('../tools/verify-original.mjs',import.meta.url),'utf8')
  ]);
  assert.match(ignore,/^\/tp-font\.woff2\s*$/m,'private font must not enter Git');
  assert.ok(verifier.includes(fontPin),'runtime visual verifier must pin the font');
  const file=new URL('../public/tp-font.woff2',import.meta.url);
  try{await stat(file);}catch(e){if(e.code==='ENOENT')return;throw e;}
  const actual=createHash('sha256').update(await readFile(file)).digest('hex');
  assert.equal(actual,fontPin,'private original font bytes changed');
});
