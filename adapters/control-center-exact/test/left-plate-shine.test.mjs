import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {correctLeftPlateShine,approvedSha} from '../tools/correct-left-plate-shine.mjs';

const original=readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const sha=s=>createHash('sha256').update(s).digest('hex');
const sourceRows=html=>{
  const match=html.match(/const EXACT_LOGO_LINES_187_TO_267 = \[([\s\S]*?)\];/);
  assert.ok(match,'approved logo data');
  const rows=[...match[1].matchAll(/"([+#*]{400})"/g)].map(m=>m[1]);
  assert.equal(rows.length,85,'85 complete glyph rows');
  return rows;
};
const selection=html=>{
  const match=html.match(/function isMarkedFlowFacet\(r, c, ch\)\s*\{\s*return ([^;]+);\s*\}/);
  assert.ok(match,'rendering uses original isMarkedFlowFacet selection');
  return vm.runInNewContext('(r,c,ch)=>('+match[1]+')');
};
const bounds=html=>{
 const find=name=>{
   const re=new RegExp('const '+name+' = ([^;]+);');
   const m=html.match(re);assert.ok(m,'missing '+name);return m[1];
 };
 const assignments=['flowLeft','flowTop','flowRight','flowBottom'].map(k=>'const '+k+' = '+find(k)+';').join('\n');
 return vm.runInNewContext('(originX,originY,charW,charH)=>{'+assignments+'return {flowLeft,flowTop,flowRight,flowBottom};}');
};

test('shine selects exactly the real solid top-left metal plate, not its shadow or the right plate',()=>{
 assert.equal(sha(original),approvedSha,'require the exact original owner HTML');
 const patched=correctLeftPlateShine(original);
 const marked=selection(patched);
 const rows=sourceRows(original);
 let count=0;
 for(let row=0;row<rows.length;row++){
  const r=row+186;
  const hashes=[...rows[row].matchAll(/#{2,}/g)];
  const target=(r>=211&&r<=230)?(r<=228?hashes[0]:hashes[1]):null;
  if(r>=211&&r<=230)assert.ok(target,'expected original left metal run at row '+r);
  const expected=new Set(target?[...Array(target[0].length).keys()].map(n=>target.index+n):[]);
  let found=0;
  for(let c=0;c<400;c++){
   const selected=!!marked(r,c,rows[row][c]);
   if(selected){
    assert.equal(rows[row][c],'#','only metallic glyphs may shimmer');
    assert.ok(expected.has(c),'shimmer must remain inside the exact left metal run at '+r+','+c);
    found++;count++;
   }
   if(expected.has(c))assert.ok(selected,'every glyph of the original left plate must be selected: '+r+','+c);
  }
  assert.equal(found,expected.size,'exact selected metal geometry at row '+r);
 }
 assert.ok(count>430,'left metal plate was not erased');
 for(const [r,c,ch] of [[236,150,'*'],[245,175,'*'],[224,246,'#'],[240,245,'#'],[235,123,'#'],[249,199,'#']]){
  assert.equal(marked(r,c,ch),false,'reject shadow, support, right metal at '+r+','+c);
 }
});

test('animation canvas bounds contain the selected left metal pixels at every viewport and DPR',()=>{
 const patched=correctLeftPlateShine(original);
 const marked=selection(patched);
 const rows=sourceRows(original);
 const makeBounds=bounds(patched);
 for(const [w,h,dpr] of [[1728,960,1],[1728,960,1.25],[1366,768,1],[1366,768,1.75],[1920,1080,2],[390,844,3]]){
  const scale=Math.min(w/215,h/215), charW=Math.max(2.6,scale*.56), charH=Math.max(4.6,scale);
  const ox=w/2-200*charW,oy=h/2-246*charH;
  const b=makeBounds(ox,oy,charW,charH);
  assert.ok(Number.isFinite(b.flowLeft)&&Number.isFinite(b.flowBottom));
  assert.ok(b.flowRight>b.flowLeft&&b.flowBottom>b.flowTop);
  for(let r=211;r<=230;r++)for(let c=120;c<=200;c++){
   if(!marked(r,c,rows[r-186][c]))continue;
   const x=ox+c*charW,y=oy+r*charH;
   assert.ok(x-b.flowLeft>=0,'clipped on left '+w+' '+r+':'+c);
   assert.ok(y-b.flowTop>=0,'clipped on top '+h+' '+r+':'+c);
   assert.ok(x+charW < b.flowRight-1,'clipped on right '+w+' '+r+':'+c);
   assert.ok(y+charH < b.flowBottom-1,'clipped on bottom '+h+' '+r+':'+c);
   assert.ok(Math.round((b.flowRight-b.flowLeft)*dpr)>=1,'physical canvas width');
  }
 }
 assert.match(patched,/const xLocal = x - flowLeft, yLocal = y - flowTop/,'local origin must cancel overlay CSS positioning');
 assert.match(patched,/darkFlowCtx\.fillText\('#', xLocal, yLocal\)/);
 assert.match(patched,/lightFlowCtx\.fillText\('#', xLocal, yLocal\)/);
 assert.match(patched,/const normProgress = \(\(198 - c\) \/ 70\) \* 0\.65 \+ \(\(r - 211\) \/ 19\) \* 0\.35/);
});

test('approved art, themes, original controls, glyph rows and placement remain exactly unchanged',()=>{
 const patched=correctLeftPlateShine(original);
 assert.notEqual(sha(patched),approvedSha);
 for(const pattern of [
  /<style id="tetherplane-utility-css">[\s\S]*?<\/style>/,
  /<style id="tetherplane-smooth-theme">[\s\S]*?<\/style>/,
  /const EXACT_LOGO_LINES_187_TO_267 = \[[\s\S]*?\];/,
  /const EXACT_WORDMARK_LINES_277_TO_306 = \[[\s\S]*?\];/,
  /const FULL_ASCII_LINES = \[[\s\S]*?\];/,
  /function toggleThemeMode\(\)\s*\{[\s\S]*?\n\s*\}/
 ]){
  const a=original.match(pattern), b=patched.match(pattern);
  assert.ok(a&&b,'needed original block present');
  assert.equal(b[0],a[0],'a protected art/theme block changed');
 }
 assert.equal((patched.match(/<canvas/g)||[]).length,(original.match(/<canvas/g)||[]).length);
 assert.equal((patched.match(/requestAnimationFrame\(renderMonochromeAscii\)/g)||[]).length,(original.match(/requestAnimationFrame\(renderMonochromeAscii\)/g)||[]).length);
});

test('unknown source refuses patch instead of silently shifting the artwork again',()=>{
 assert.throws(()=>correctLeftPlateShine(original+' '),/original|baseline|SHA|hash|approved/i);
});
