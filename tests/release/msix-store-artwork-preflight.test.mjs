import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { pngSize, jpegSize, sha256, sizes, validate } from "../../scripts/msix-store/verify-store-listing-assets.mjs";

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
// Metadata-only SOF JPEG test fixture; it is intentionally NOT a decodable
// photograph. Windows CI separately exercises actual JPEG decoding.
function jpegMeta(width, height) {
  const frame = Buffer.from([0xff,0xd8,0xff,0xc0,0,0x11,8,0,0,0,0,3,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xd9]);
  frame.writeUInt16BE(height, 7);
  frame.writeUInt16BE(width, 9);
  return Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0,0,0x12]), Buffer.alloc(16), frame.subarray(2)]);
}
function fixture(sourceFormat = "png_alpha") {
  const root = mkdtempSync(join(tmpdir(), "tetherplane-store-asset-fixture-"));
  const assets = join(root, "assets"); mkdirSync(assets);
  const source = join(root, sourceFormat === "jpeg_opaque" ? "source.jpg" : "source.png");
  const sourceBuffer = sourceFormat === "jpeg_opaque" ? jpegMeta(512, 512) : png(512, 512);
  writeFileSync(source, sourceBuffer);
  const hashes = {};
  for (const [name, dimension] of Object.entries(sizes)) {
    const bytes = png(dimension, dimension);
    writeFileSync(join(assets, name), bytes);
    hashes[name] = sha256(bytes);
  }
  const evidencePath = join(assets, "asset-evidence.UNAPPROVED.json");
  writeFileSync(evidencePath, JSON.stringify({
    schema: "tetherplane.store-artwork-preflight.v2",
    package_identity: "ARCUSLabs.Tetherplane",
    disposition: "UNAPPROVED_SOURCE_TRANSFORM",
    source_sha256: sha256(sourceBuffer),
    source_format: sourceFormat,
    source_square_pixels: 512,
    files: hashes,
    screenshot: "NOT_CAPTURED",
    owner_approval_reference: null
  }));
  return { root, assetsDir: assets, source, evidencePath };
}
const withFixture = (fn, sourceFormat = "png_alpha") => { const f = fixture(sourceFormat); try { return fn(f); } finally { rmSync(f.root, {recursive: true, force: true}); } };

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

test("JPEG SOF dimensions are inspected without claiming image decode", () => {
  assert.deepEqual(jpegSize(jpegMeta(1062, 1062)), {width: 1062, height: 1062});
  assert.throws(() => jpegSize(Buffer.alloc(20)), /STORE_ASSET_INVALID_JPEG_HEADER/);
});

test("exact opaque JPEG source is allowed with hash-pinned, still-unapproved PNG exports", () =>
  withFixture(f => {
    const result = validate(f);
    assert.equal(result.source_bytes_verified, true);
    assert.equal(result.owner_approval, "NOT_GRANTED");
    assert.equal(result.genuine_visual_review, "NOT_RUN");
  }, "jpeg_opaque"));

test("rejects source-format forgery and source byte changes", () =>
  withFixture(f => {
    const evidence = JSON.parse(readFileSync(f.evidencePath,"utf8"));
    evidence.source_format = "png_alpha";
    writeFileSync(f.evidencePath, JSON.stringify(evidence));
    assert.throws(() => validate(f), /STORE_ASSET_SOURCE_FORMAT_MISMATCH/);
    evidence.source_format = "jpeg_opaque";
    writeFileSync(f.evidencePath, JSON.stringify(evidence));
    writeFileSync(f.source, jpegMeta(900,900));
    assert.throws(() => validate(f), /STORE_ASSET_ORIGINAL_SOURCE_MISMATCH/);
  }, "jpeg_opaque"));

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
  assert.match(script, /STORE_ARTWORK_JPEG_FORMAT_MISMATCH/);
  assert.match(script, /jpeg_opaque/);
  assert.match(script, /UNAPPROVED_SOURCE_TRANSFORM/);
  assert.match(script, /STORE_ARTWORK_MECHANICAL_EXPORT_PASS_NOT_APPROVED/);
  assert.doesNotMatch(script, /Add-AppxPackage|Import-Certificate|New-SelfSignedCertificate|Submit-Store|Register-ScheduledTask|Set-MpPreference/);
  const workflow = readFileSync(new URL("../../.github/workflows/msix-store-artwork-preflight.yml", import.meta.url), "utf8");
  assert.match(workflow, /STORE_ARTWORK_SYNTHETIC_JPEG_EXPORT_PASS_NOT_APPROVED/);
  assert.match(workflow, /STORE_ARTWORK_JPEG_FALSE_APPROVAL_CLAIM/);
  assert.doesNotMatch(workflow, /upload-artifact|Add-AppxPackage|Import-Certificate|submit-to-store/i);
});
