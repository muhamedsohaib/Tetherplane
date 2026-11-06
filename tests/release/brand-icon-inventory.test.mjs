import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (name) => readFileSync(path.join(root, name));
const text = (name) => read(name).toString("utf8");
const hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expectedOriginal = {
  "branding/sources/logo-black-original.png": "a68a4782baa855b2d58158e7a205802b875f64f84147c879a9b3d6e1c5677f09",
  "branding/sources/logo-white-on-black-original.jpg": "c964d071774f67ec83b85207e5ff2511e441f3676b5d92893cffe974a74d0e12",
};
function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(width, height, "all app icons must be proportionally padded on square canvas");
  return width;
}

test("source artwork is byte-exact to user-supplied icon pack", () => {
  for (const [file, checksum] of Object.entries(expectedOriginal)) {
    assert.equal(hex(read(file)), checksum, file);
  }
});

test("every exported icon is hash-checked with no placeholder substitution", () => {
  const m = JSON.parse(text("branding/brand-asset-manifest.json"));
  assert.equal(m.schema, "tetherplane.exact-user-supplied-brand-icon-pack.v1");
  assert.equal(m.store_submission_approved, false);
  for (const [name, entry] of Object.entries(m.files)) {
    const contents = read(name);
    assert.equal(contents.length, entry.bytes, "size drift: " + name);
    assert.equal(hex(contents), entry.sha256, "pixel byte drift: " + name);
    if (name.endsWith(".png")) {
      const match = name.match(/(?:brand-|Logo|black-|white-)(\d+)\.png$/);
      if (match) assert.equal(pngSize(contents), Number(match[1]));
    }
  }
});

test("extension manifest, popup and package all resolve canonical icons", () => {
  const m = JSON.parse(text("extension/browser/manifest.json"));
  const iconPaths = [
    "icons/brand-16.png",
    "icons/brand-32.png",
    "icons/brand-48.png",
    "icons/brand-128.png",
  ];
  assert.deepEqual(Object.values(m.icons), iconPaths);
  assert.deepEqual(Object.values(m.action.default_icon), iconPaths);
  for (const name of [...iconPaths, "icons/black-64.png"]) {
    assert.ok(existsSync(path.join(root, "extension/browser", name)), name);
  }
  const popup = text("extension/browser/pair.html");
  assert.match(popup, /icons\/black-64\.png/);
  assert.doesNotMatch(popup, /class="mark"|\.mark:after|#174cb3[^}]*border/);
  assert.match(text("scripts/package-windows.ps1"), /canonicalExtensionIcons/);
});

test("MSIX and setup branding have no unconfigured source paths", () => {
  for (const [file, size] of Object.entries({
    "branding/windows/Logo44.png": 44,
    "branding/windows/Logo50.png": 50,
    "branding/windows/Logo150.png": 150,
    "branding/windows/Logo300.png": 300,
    "packaging/msix-store-runtime/app/assets/brand-32.png": 32,
    "packaging/msix-store-runtime/app/assets/brand-128.png": 128,
  })) {
    assert.equal(pngSize(read(file)), size, file);
  }
  const html = text("packaging/msix-store-runtime/app/setup.html");
  assert.match(html, /assets\/brand-32\.png/);
  assert.match(html, /assets\/brand-128\.png/);
  const server = text("packaging/msix-store-runtime/app/runtime-app.mjs");
  assert.match(server, /img-src 'self'/);
  for (const suffix of ["brand-32.png", "brand-128.png"]) {
    assert.ok(server.includes('"/assets/' + suffix + '"'));
  }
});
