import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// The approved proprietary image remains outside Git. Never modify it in place.
export const approvedSha='36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82';
const sha=s=>createHash('sha256').update(s).digest('hex');

export function correctLeftPlateShine(html){
  if(sha(html)!==approvedSha)throw new Error('Approved original artwork SHA-256 mismatch');
  let result=html;
  const once=(before,after,why)=>{
    if(result.split(before).length!==2)throw new Error('Unrecognized original '+why+' anchor');
    result=result.replace(before,after);
  };

  // The source ASCII marks the upper-left solid metal in '#', rows 211..230.
  // Below it, '*' represents the *non-metallic shaded interior*. Do not animate it.
  // The right-hand '#' metal belongs to the other face and must stay unchanged.
  once("Isolate ONLY the marked lower-left shaded '*' facet of the 3D cube",
       "Animate ONLY the solid upper-left metallic '#' plate of the 3D cube",
       'facet description');
  once("(rows 231..257, cols 134..192) for the synchronous liquid heartbeat flow.",
       "(rows 211..230; exact left '#' run) for the synchronous liquid heartbeat flow.",
       'facet row description');
  once("Every other glyph ('#', '+', and edge '*') stays 100% static.",
       "All right-side '#', supports, and shaded interior '*' glyphs stay static.",
       'stationary glyph description');
  once("return ch === '*' && r >= 231 && r <= 257 && c >= 134 && c <= 192;",
       "return ch === '#' && r >= 211 && r <= 230 && c <= 198 && (r <= 228 || c >= 133);",
       'exact left plate selection');
  once("Normalized 0..1 position along the diagonal conduit from left pillar to bottom-center pillar",
       "Normalized 0..1 movement across the upper-left metal, from the top joint toward the left pillar",
       'wave direction description');
  once("const normProgress = ((c - 134) / 58) * 0.65 + ((r - 231) / 26) * 0.35;",
       "const normProgress = ((198 - c) / 70) * 0.65 + ((r - 211) / 19) * 0.35;",
       'wave progress');
  once("animation repaints ONLY the original small '*' facet on tiny canvases.",
       "animation repaints ONLY the exact upper-left metallic '#' glyphs on tiny canvases.",
       'render note');

  // A pixel-space overlay remains co-registered with the static full lattice.
  // Margin includes actual glyph width/height at fractional devicePixelRatio.
  once("const flowLeft = Math.floor(originX + 132 * charW) - 3;",
       "const flowLeft = Math.floor(originX + 125 * charW) - 3;",
       'canvas left bound');
  once("const flowTop = Math.floor(originY + 229 * charH) - 3;",
       "const flowTop = Math.floor(originY + 209 * charH) - 3;",
       'canvas top bound');
  once("const flowRight = Math.ceil(originX + 196 * charW) + 4;",
       "const flowRight = Math.ceil(originX + 202 * charW) + 4;",
       'canvas right bound');
  once("const flowBottom = Math.ceil(originY + 260 * charH) + 4;",
       "const flowBottom = Math.ceil(originY + 233 * charH) + 4;",
       'canvas bottom bound');

  // The plate stays metallic even between wave crests; the wave adds luminance.
  once("const alpha = Math.min(0.98, 0.18 + laminarWave * 0.72 + boost * 0.18);",
       "const alpha = Math.min(0.98, 0.78 + laminarWave * 0.20 + boost * 0.10);",
       'steady metallic baseline');

  const oldDraw="fillText('*', xLocal, yLocal);";
  if(result.split(oldDraw).length!==3)throw new Error('Exactly two dark/light glyph overlays required');
  result=result.split(oldDraw).join("fillText('#', xLocal, yLocal);");
  return result;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [source,dest]=process.argv.slice(2);
  if(!source||!dest||resolve(source)===resolve(dest))throw new Error('Pass different approved input and new output paths');
  if(existsSync(dest))throw new Error('Refusing to overwrite any existing output');
  const contents=correctLeftPlateShine(readFileSync(source,'utf8'));
  writeFileSync(dest,contents,{encoding:'utf8',flag:'wx'});
  process.stdout.write('LEFT_PLATE_PATCH_SHA256='+sha(contents)+'\n');
}
