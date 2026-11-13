import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const script=path.resolve(dir,'../../website/netlify/seo/patch-head.mjs');
const oldTitle='tetherplane by ARCUS Labs — Permission-Controlled AI Computer Operations & Assisted Windows Pilot';
const oldDescription='Put AI to work on your PC on your terms. tetherplane is an open-source MCP control plane for permission-scoped computer operations. Request an ARCUS Labs assisted Windows pilot (Proposed X).';
const fixture='<!DOCTYPE html>\n<html lang="en"><head>\n<title>'+oldTitle+'</title>\n<meta name="description" content="'+oldDescription+'" />\n<meta name="robots" content="index, follow" />\n<link rel="canonical" href="https://tetherplane.netlify.app/" />\n</head>\n<body>KEEP ALL ANIMATIONS AND FORMS EXACTLY</body></html>';
function run(contents,mode='normal'){
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tetherplane-seo-'));
 try{
  const src=path.join(tmp,'input.html'),dst=path.join(tmp,'output.html');
  fs.writeFileSync(src,contents);
  const result=spawnSync(process.execPath,[script,src,mode==='same'?src:dst],{encoding:'utf8'});
  return {result,after:fs.existsSync(dst)?fs.readFileSync(dst,'utf8'):null,source:fs.readFileSync(src,'utf8')};
 } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
}
test('only edits head and emits valid source-code JSON-LD',()=>{
 const {result,after,source}=run(fixture);
 assert.equal(result.status,0,result.stderr);
 assert.equal(source,fixture);
 assert.equal(source.split('</head>')[1],after.split('</head>')[1]);
 assert.match(after,/<title>Tetherplane — Open-Source MCP Computer Control \| ARCUS Labs<\/title>/);
 const ld=after.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
 assert.ok(ld);
 const o=JSON.parse(ld[1]);
 assert.equal(o['@graph'][1].codeRepository,'https://github.com/muhamedsohaib/Tetherplane');
 assert.equal(o['@graph'][0].name,'Tetherplane');
 assert.match(result.stdout,/STAGED_REVIEW_ONLY/);
});
test('rejects unexpected title',()=>{const r=run(fixture.replace(oldTitle,'Unexpected'));assert.notEqual(r.result.status,0);assert.equal(r.after,null)});
test('rejects in-place writes',()=>{const r=run(fixture,'same');assert.notEqual(r.result.status,0);assert.equal(r.after,null)});
test('rejects injected Netlify HUD responses',()=>{const r=run(fixture+'<script src="/.netlify/scripts/hud" data-netlify-site-id="x"></script>');assert.notEqual(r.result.status,0);assert.equal(r.after,null)});
test('rejects existing schema to avoid duplication',()=>{const r=run(fixture.replace('</head>','<script type="application/ld+json">{}</script></head>'));assert.notEqual(r.result.status,0);assert.equal(r.after,null)});
