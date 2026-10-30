import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { pngSize, sha256, sizes, validate } from "../../scripts/msix-store/verify-store-listing-assets.mjs";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, content) {
  const tag = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(content.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tag, content])));
  return Buffer.concat([len, tag, content, crc]);
}
// Small real PNG fixtures, never shipped as genuine logo/screenshot art.
function png(width, height, rgb = [0, 0, 0]) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4);
  head[8] = 8; head[9] = 2;
  const row = Buffer.alloc(width * 3 + 1, 0);
  for (let i = 0; i < width; i++) row.set(rgb, i * 3 + 1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({length: height}, () => row)))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tetherplane-store-asset-fixture-"));
  const assets = join(root, "assets"); mkdirSync(assets);
  const source = join(root, "source.png");
  const sourceBuffer = png(512, 512);
  writeFileSync(source, sourceBuffer);
  const hashes = {};
  for (const [name, dimension] of Object.entries(sizes)) {
    const bytes = png(dimension, dimension);
    writeFileSync(join(assets, name), bytes);
    hashes[name] = sha256(bytes);
  }
  const evidencePath = join(assets, "asset-evidence.UNAPPROVED.json");
  writeFileSync(evidencePath, JSON.stringify({
    schema: "tetherplane.store-artwork-preflight.v1",
    package_identity: "ARCUSLabs.Tetherplane",
    disposition: "UNAPPROVED_SOURCE_TRANSFORM",
    source_sha256: sha256(sourceBuffer),
    source_square_pixels: 512,
    files: hashes,
    screenshot: "NOT_CAPTURED",
    owner_approval_reference: null
  }));
  return { root, assetsDir: assets, source, evidencePath };
}
const withFixture = (fn) => { const f = fixture(); try { return fn(f); } finally { rmSync(f.root, {recursive: true, force: true}); } };

test("PNG metadata accepts canonical icon dimensions without interpreting pixels", () => {
  assert.deepEqual(pngSize(png(44,44)), {width:44, height:44});
  assert.throws(() => pngSize(Buffer.alloc(40)), /STORE_ASSET_INVALID_PNG_HEADER/);
  assert.equal(sha256(Buffer.from("abc")), createHash("sha256").update("abc").digest("hex"));
});

test("matching source and 4 exact icon hashes are preflight-only, not approval", () => withFixture(f => {
  const result = validate(f);
  assert.equal(result.exported_icon_hashes_verified, true);
  assert.equal(result.disposition, "NOT_APPROVED_FOR_STORE");
  assert.equal(result.owner_approval, "NOT_GRANTED");
  assert.equal(result.screenshot_status, "NOT_PROVIDED");
}));

test("must fail without screenshot if gate requires one", () => withFixture(f => {
  assert.throws(() => validate({...f,requireScreenshot:true}), /STORE_SCREENSHOT_REQUIRED/);
}));

test("rejects changed icon bytes or approved-claim injection", () => withFixture(f => {
  writeFileSync(join(f.assetsDir,"Logo44.png"), png(44,44,[255,0,0]));
  assert.throws(() => validate(f), /STORE_ASSET_HASH_OR_DIMENSION_MISMATCH/);
  const original = JSON.parse(readFileSync(f.evidencePath,"utf8"));
  original.owner_approval_reference = "FORGED_APPROVAL";
  writeFileSync(f.evidencePath, JSON.stringify(original));
  assert.throws(() => validate(f), /STORE_ASSET_EVIDENCE_NOT_UNAPPROVED_PREVIEW/);
}));

test("screenshot dimensions are checked but no authenticity claim is issued", () => withFixture(f => {
  const screenshot = join(f.root, "unverified-screenshot.png");
  writeFileSync(screenshot, png(1366,768));
  const result = validate({...f,screenshot,requireScreenshot:true});
  assert.equal(result.screenshot_status, "DIMENSIONS_ONLY_NO_AUTHENTICITY_OR_PRIVACY_REVIEW");
  assert.equal(result.manual_privacy_review, "NOT_RUN");
  writeFileSync(screenshot, png(1000,600));
  assert.throws(() => validate({...f,screenshot}), /STORE_SCREENSHOT_BELOW_DESKTOP_REQUIREMENT/);
}));

test("Windows-only exporter can never silently stamp owner approval", () => {
  const script = readFileSync(new URL("../../scripts/msix-store/Prepare-StoreArtwork.ps1", import.meta.url), "utf8");
  assert.match(script, /STORE_ARTWORK_SOURCE_HASH_MISMATCH/);
  assert.match(script, /STORE_ARTWORK_REFUSES_EXISTING_OUTPUT/);
  assert.match(script, /STORE_ARTWORK_TRANSPARENT_PNG_REQUIRED/);
  assert.match(script, /UNAPPROVED_SOURCE_TRANSFORM/);
  assert.match(script, /STORE_ARTWORK_MECHANICAL_EXPORT_PASS_NOT_APPROVED/);
  assert.doesNotMatch(script, /Add-AppxPackage|Import-Certificate|New-SelfSignedCertificate|Submit-Store|Register-ScheduledTask|Set-MpPreference/);
});
