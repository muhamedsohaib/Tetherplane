// Deterministic artwork-only motion patch. The approved glyph lattice is immutable.
// Usage: node tools/patch-plate-shine.mjs <approved-original.html> <new-preview.html>
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ORIGINAL_SHA256='36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82';
export const sha256=s=>createHash('sha256').update(s).digest('hex');

export function patchPlateShine(original){
  if(sha256(original)!==ORIGINAL_SHA256)throw new Error('Approved original artwork SHA-256 does not match pinned baseline');
  let html=original;
  function replaceOnce(before,after,label){
    const pieces=html.split(before);
    if(pieces.length!==2)throw new Error('Unrecognized '+label+'; exactly one patch anchor required');
    html=pieces.join(after);
  }
  // The original animation targets '*' in the LEFT shaded gap. The polished
  // metallic plate is the RIGHT diagonal run of '#' between the two supports.
  // Anchor motion to its existing glyphs, not a viewport-positioned highlight.
  replaceOnce(
    "         * Isolate ONLY the marked lower-left shaded '*' facet of the 3D cube",
    "         * Isolate ONLY the solid right-hand metallic '#' plate of the 3D cube",
    'facet-intent'
  );
  replaceOnce(
    "         * (rows 231..257, cols 134..192) for the synchronous liquid heartbeat flow.",
    "         * (rows 231..256, cols 206..265) for the synchronous liquid heartbeat flow.",
    'facet-bounds-doc'
  );
  replaceOnce(
    "         * Every other glyph ('#', '+', and edge '*') stays 100% static.",
    "         * The exact ASCII glyph lattice stays unchanged; all other glyphs are static.",
    'glyph-guarantee'
  );
  replaceOnce(
    "return ch === '*' && r >= 231 && r <= 257 && c >= 134 && c <= 192;",
    "return ch === '#' && r >= 231 && r <= 256 && c >= 206 && c <= 265;",
    'facet-mask'
  );
  replaceOnce(
    "                    // Normalized 0..1 position along the diagonal conduit from left pillar to bottom-center pillar",
    "                    // Normalized 0..1 position along the solid right plate toward the bottom-center pillar",
    'flow-direction-doc'
  );
  replaceOnce(
    "const normProgress = ((c - 134) / 58) * 0.65 + ((r - 231) / 26) * 0.35;",
    "const normProgress = ((265 - c) / 59) * 0.65 + ((r - 231) / 25) * 0.35;",
    'wave-progress'
  );
  replaceOnce(
    "        // animation repaints ONLY the original small '*' facet on tiny canvases.",
    "        // animation repaints ONLY the metallic right '#' plate on tiny canvases.",
    'render-purpose'
  );
  replaceOnce(
    "const flowLeft = Math.floor(originX + 132 * charW) - 3;",
    "const flowLeft = Math.floor(originX + 204 * charW) - 3;",
    'canvas-left'
  );
  replaceOnce(
    "const flowRight = Math.ceil(originX + 196 * charW) + 4;",
    "const flowRight = Math.ceil(originX + 267 * charW) + 4;",
    'canvas-right'
  );
  replaceOnce(
    "const flowBottom = Math.ceil(originY + 260 * charH) + 4;",
    "const flowBottom = Math.ceil(originY + 259 * charH) + 4;",
    'canvas-bottom'
  );
  replaceOnce(
    "const alpha = Math.min(0.98, 0.18 + laminarWave * 0.72 + boost * 0.18);",
    "const alpha = Math.min(0.98, 0.72 + laminarWave * 0.26 + boost * 0.10);",
    'glint-opacity'
  );
  const before="fillText('*', xLocal, yLocal);";
  if(html.split(before).length!==3)throw new Error('Exactly two theme flow draws required');
  html=html.split(before).join("fillText('#', xLocal, yLocal);");
  return html;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,output]=process.argv.slice(2);
  if(!input||!output||resolve(input)===resolve(output)){
    throw new Error('Provide distinct original input and new output paths');
  }
  if(existsSync(output))throw new Error('Refusing to overwrite an existing output file');
  const patched=patchPlateShine(readFileSync(input,'utf8'));
  writeFileSync(output,patched,{encoding:'utf8',flag:'wx'});
  process.stdout.write('PLATE_PATCH_SHA256='+sha256(patched)+'\n');
}
