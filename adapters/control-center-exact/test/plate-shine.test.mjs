import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {patchPlateShine,ORIGINAL_SHA256} from '../tools/patch-plate-shine.mjs';

const approved=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const digest=v=>createHash('sha256').update(v).digest('hex');
const animationSource=html=>{
  const m=html.match(/function isMarkedFlowFacet\(r, c, ch\)\s*\{\s*(return [^;]+;)\s*\}/);
  assert.ok(m,'facet selection function retained');
  return vm.runInNewContext('(r,c,ch)=>{'+m[1]+'}');
};
const baseGlyphRows=html=>{
  const m=html.match(/const EXACT_LOGO_LINES_187_TO_267 = \[\s*([\s\S]*?)\s*\];/);
  assert.ok(m,'source logo strings exist');
  const rows=[...m[1].matchAll(/"([+#*]{400})"/g)].map(x=>x[1]);
  assert.equal(rows.length,85,'source artwork row count');
  return rows;
};

test('animated shine is exclusively mapped to the exact right metallic plate hashes',()=>{
  assert.equal(digest(approved),ORIGINAL_SHA256,'original art baseline must be unchanged');
  const patched=patchPlateShine(approved);
  assert.notEqual(digest(patched),ORIGINAL_SHA256,'corrective motion patch must change something');
  const isFacet=animationSource(patched);
  const rows=baseGlyphRows(approved);
  let total=0;
  for(let localR=0;localR<rows.length;localR++){
    const r=186+localR;
    for(let c=0;c<400;c++){
      const glyph=rows[localR][c];
      if(!isFacet(r,c,glyph))continue;
      assert.equal(glyph,'#','animated glyph must belong to solid plate');
      assert.ok(r>=231&&r<=256,'highlight must be in plate vertical extent');
      assert.ok(c>=206&&c<=265,'highlight must not leave metallic plate or enter support pillars');
      total++;
    }
  }
  assert.ok(total>250,'plate animation cannot be empty');
  assert.equal(isFacet(237,250,'#'),true,'right face is animated');
  assert.equal(isFacet(237,273,'#'),false,'right support pillar stays static');
  assert.equal(isFacet(250,198,'#'),false,'center support pillar stays static');
  assert.equal(isFacet(240,159,'*'),false,'left hatch is no longer animated');
});

test('shine overlay retains pixel-space alignment and both theme transitions',()=>{
  const patched=patchPlateShine(approved);
  assert.match(patched,/flowLeft = Math\.floor\(originX \+ 204 \* charW\) - 3/);
  assert.match(patched,/flowRight = Math\.ceil\(originX \+ 267 \* charW\) \+ 4/);
  assert.match(patched,/flowTop = Math\.floor\(originY \+ 229 \* charH\) - 3/);
  assert.match(patched,/flowBottom = Math\.ceil\(originY \+ 259 \* charH\) \+ 4/);
  assert.match(patched,/darkFlowCtx\.fillText\('#', xLocal, yLocal\)/);
  assert.match(patched,/lightFlowCtx\.fillText\('#', xLocal, yLocal\)/);
  assert.match(patched,/const xLocal = x - flowLeft, yLocal = y - flowTop/);
  assert.equal(patched.match(/requestAnimationFrame\(renderMonochromeAscii\)/g)?.length,approved.match(/requestAnimationFrame\(renderMonochromeAscii\)/g)?.length);
  assert.equal(patched.match(/transition: opacity 680ms/g)?.length,approved.match(/transition: opacity 680ms/g)?.length);
});

test('source 400-column image, wordmark, background and theme styling remain byte-identical',()=>{
  const patched=patchPlateShine(approved);
  for(const pattern of [
    /<style id="tetherplane-utility-css">[\s\S]*?<\/style>/,
    /<style id="tetherplane-smooth-theme">[\s\S]*?<\/style>/,
    /const EXACT_LOGO_LINES_187_TO_267 = \[[\s\S]*?\];/,
    /const EXACT_WORDMARK_LINES_277_TO_306 = \[[\s\S]*?\];/,
    /<div id="ascii-bg-container"[\s\S]*?<\/div>\s*<\/div>/
  ]){
    const a=approved.match(pattern),b=patched.match(pattern);
    assert.ok(a&&b,'expected preserved region exists');
    assert.equal(b[0],a[0],'approved original region unchanged');
  }
  assert.equal((patched.match(/<canvas/g)||[]).length,(approved.match(/<canvas/g)||[]).length,'existing canvas hierarchy preserved');
});

test('wrong original artwork is rejected instead of silently applying a patch',()=>{
  assert.throws(()=>patchPlateShine(approved+' '),/original|hash|pinned|baseline|SHA/i);
});
