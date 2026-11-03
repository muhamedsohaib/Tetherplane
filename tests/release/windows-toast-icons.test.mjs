import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

for (const variant of ["black-on-white", "white-on-black"]) {
  test(`${variant} preserves supplied art and contains all Windows icon sizes`, () => {
    const manifest = JSON.parse(read("assets/windows/icon-provenance.json"));
    const entry = manifest.images.find((item) => item.variant === variant);
    assert.ok(entry);
    assert.equal(createHash("sha256").update(read(entry.source)).digest("hex"), entry.sourceSha256);
    const bytes = read(entry.icon);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.iconSha256);
    assert.equal(bytes.readUInt16LE(0), 0);
    assert.equal(bytes.readUInt16LE(2), 1);
    assert.equal(bytes.readUInt16LE(4), sizes.length);
    let nextOffset = 6 + 16 * sizes.length;
    sizes.forEach((size, index) => {
      const offset = 6 + 16 * index;
      assert.equal(bytes[offset] || 256, size);
      assert.equal(bytes[offset + 1] || 256, size);
      assert.equal(bytes.readUInt16LE(offset + 4), 1);
      assert.equal(bytes.readUInt16LE(offset + 6), 32);
      const length = bytes.readUInt32LE(offset + 8);
      assert.equal(bytes.readUInt32LE(offset + 12), nextOffset);
      const png = bytes.subarray(nextOffset, nextOffset + length);
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
      nextOffset += length;
    });
    assert.equal(nextOffset, bytes.length);
  });
}

test("beta shortcut exposes its icon identity and the kit carries both variants", () => {
  const registrar = read("scripts/windows/Register-TetherplaneToastBeta.ps1").toString();
  const builder = read("scripts/windows/Build-TetherplaneToastBetaKit.ps1").toString();
  assert.match(registrar, /IconLocation\s*=\s*\[string\]\$shortcut.IconLocation/);
  assert.match(registrar, /\$shortcut.IconLocation\s*=\s*\$iconLocation/);
  assert.match(registrar, /BETA_TOAST_DIFFERENT_ICON/);
  assert.match(registrar, /BETA_TOAST_ICON_HASH_MISMATCH/);
  const manifest = JSON.parse(read("assets/windows/icon-provenance.json"));
  for (const item of manifest.images) {
    assert.ok(registrar.includes(item.iconSha256.toUpperCase()), `approved icon hash missing: ${item.variant}`);
  }
  assert.match(builder, /tetherplane-black-on-white\.ico/);
  assert.match(builder, /tetherplane-white-on-black\.ico/);
});
