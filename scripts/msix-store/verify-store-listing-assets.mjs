#!/usr/bin/env node
// Read-only byte/format/hash checks. These cannot authenticate artwork identity,
// prove a screenshot depicts a real app, or perform privacy review / owner approval.
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const sizes = Object.freeze({
  "Logo44.png": 44,
  "Logo50.png": 50,
  "Logo150.png": 150,
  "Logo300.png": 300
});

const MAX_ICON_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const hex64 = /^[0-9a-f]{64}$/i;
const err = (id) => { throw new Error(id); };
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function safeFile(path, maxBytes) {
  const meta = lstatSync(path);
  if (!meta.isFile() || meta.isSymbolicLink() || meta.size < 33 || meta.size > maxBytes) {
    err("STORE_ASSET_NOT_REGULAR_PNG_OR_SIZE_OUTSIDE_LIMIT");
  }
  return readFileSync(realpathSync(path));
}

export function pngSize(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    err("STORE_ASSET_INVALID_PNG_HEADER");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compression = bytes[26];
  const filter = bytes[27];
  const interlace = bytes[28];
  if (!width || !height || width > 10000 || height > 10000 ||
      bitDepth !== 8 || ![2, 6].includes(colorType) ||
      compression !== 0 || filter !== 0 || interlace !== 0) {
    err("STORE_ASSET_UNSUPPORTED_PNG_FORMAT");
  }
  // Header inspection intentionally does not pretend to decode image content.
  return { width, height };
}

/** JPEG SOF inspection only; full decode is separately exercised by the Windows exporter. */
export function jpegSize(bytes) {
  if (bytes.length < 18 || bytes.readUInt16BE(0) !== 0xffd8) {
    err("STORE_ASSET_INVALID_JPEG_HEADER");
  }
  let index = 2;
  while (index + 4 <= bytes.length) {
    if (bytes[index++] !== 0xff) err("STORE_ASSET_INVALID_JPEG_MARKER");
    while (index < bytes.length && bytes[index] === 0xff) index++;
    if (index >= bytes.length) break;
    const marker = bytes[index++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (index + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(index);
    if (length < 2 || index + length > bytes.length) err("STORE_ASSET_INVALID_JPEG_SEGMENT");
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 8 || bytes[index+2] !== 8 || bytes[index+7] < 1) {
        err("STORE_ASSET_UNSUPPORTED_JPEG_FRAME");
      }
      return { width: bytes.readUInt16BE(index+5), height: bytes.readUInt16BE(index+3) };
    }
    index += length;
  }
  err("STORE_ASSET_JPEG_FRAME_NOT_FOUND");
}

export function validate({ source, assetsDir, evidencePath, screenshot, requireScreenshot = false }) {
  if (!source || !assetsDir || !evidencePath) err("STORE_ASSET_INPUTS_REQUIRED");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  if (evidence.schema !== "tetherplane.store-artwork-preflight.v2" ||
      evidence.package_identity !== "ARCUSLabs.Tetherplane" ||
      evidence.disposition !== "UNAPPROVED_SOURCE_TRANSFORM" ||
      evidence.owner_approval_reference !== null ||
      evidence.screenshot !== "NOT_CAPTURED" ||
      !hex64.test(evidence.source_sha256 ?? "")) {
    err("STORE_ASSET_EVIDENCE_NOT_UNAPPROVED_PREVIEW");
  }
  const sourceBytes = safeFile(source, 20 * 1024 * 1024);
  const extension = extname(source).toLowerCase();
  const expectedFormat = extension === ".png" ? "png_alpha" :
    [".jpg", ".jpeg"].includes(extension) ? "jpeg_opaque" : null;
  if (!expectedFormat || evidence.source_format !== expectedFormat) {
    err("STORE_ASSET_SOURCE_FORMAT_MISMATCH");
  }
  const sourceSize = expectedFormat === "png_alpha" ? pngSize(sourceBytes) : jpegSize(sourceBytes);
  if (sourceSize.width !== sourceSize.height || sourceSize.width !== evidence.source_square_pixels ||
      sourceSize.width < 512 || sha256(sourceBytes) !== evidence.source_sha256.toLowerCase()) {
    err("STORE_ASSET_ORIGINAL_SOURCE_MISMATCH");
  }
  if (Object.keys(evidence.files ?? {}).sort().join("|") !== Object.keys(sizes).sort().join("|")) {
    err("STORE_ASSET_INVENTORY_MISMATCH");
  }
  for (const [name, expectedSize] of Object.entries(sizes)) {
    const buffer = safeFile(join(assetsDir, name), MAX_ICON_BYTES);
    const actualSize = pngSize(buffer);
    if (actualSize.width !== expectedSize || actualSize.height !== expectedSize ||
        !hex64.test(evidence.files[name]) || sha256(buffer) !== evidence.files[name].toLowerCase()) {
      err("STORE_ASSET_HASH_OR_DIMENSION_MISMATCH");
    }
  }
  let screenshotStatus = "NOT_PROVIDED";
  if (screenshot) {
    const bytes = safeFile(screenshot, MAX_SCREENSHOT_BYTES);
    const { width, height } = pngSize(bytes);
    if (!((width >= 1366 && height >= 768) || (height >= 1366 && width >= 768))) {
      err("STORE_SCREENSHOT_BELOW_DESKTOP_REQUIREMENT");
    }
    screenshotStatus = "DIMENSIONS_ONLY_NO_AUTHENTICITY_OR_PRIVACY_REVIEW";
  } else if (requireScreenshot) {
    err("STORE_SCREENSHOT_REQUIRED");
  }
  return {
    disposition: "NOT_APPROVED_FOR_STORE",
    source_bytes_verified: true,
    exported_icon_hashes_verified: true,
    screenshot_status: screenshotStatus,
    genuine_visual_review: "NOT_RUN",
    manual_privacy_review: "NOT_RUN",
    publisher_account_eligibility: "NOT_VERIFIED",
    owner_approval: "NOT_GRANTED"
  };
}

const calledDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (calledDirectly) {
  const args = process.argv.slice(2);
  const flags = new Set(["--source", "--assets-dir", "--evidence", "--screenshot", "--require-screenshot"]);
  const obj = {};
  for (let i = 0; i < args.length; i++) {
    if (!flags.has(args[i]) || Object.hasOwn(obj, args[i])) err("STORE_ASSET_CLI_UNKNOWN_OR_DUPLICATE_ARG");
    if (args[i] === "--require-screenshot") { obj[args[i]] = true; continue; }
    if (i + 1 >= args.length || args[i + 1].startsWith("--")) err("STORE_ASSET_CLI_MISSING_VALUE");
    obj[args[i]] = args[++i];
  }
  try {
    console.log(JSON.stringify(validate({
      source: obj["--source"],
      assetsDir: obj["--assets-dir"],
      evidencePath: obj["--evidence"],
      screenshot: obj["--screenshot"],
      requireScreenshot: obj["--require-screenshot"] === true
    })));
  } catch (error) {
    process.stderr.write(String(error.message).slice(0, 120) + "\n");
    process.exitCode = 2;
  }
}
