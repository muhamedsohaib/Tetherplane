import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("MV3 manifest exposes only browser-control permissions required by B4", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(here, "..", "manifest.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as Record<string, unknown>;

  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.background, {
    service_worker: "dist/background.js",
    type: "module",
  });
  const brandIcons = {
    "16": "icons/brand-16.png",
    "32": "icons/brand-32.png",
    "48": "icons/brand-48.png",
    "128": "icons/brand-128.png",
  };
  assert.deepEqual(manifest.icons, brandIcons);
  assert.deepEqual(manifest.action, {
    default_popup: "pair.html",
    default_icon: brandIcons,
  });
  for (const file of Object.values(brandIcons)) {
    const png = await readFile(path.resolve(here, "..", file));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
  const popupHtml = await readFile(path.resolve(here, "..", "pair.html"), "utf8");
  assert.match(popupHtml, /icons\/black-64\.png/);
  assert.doesNotMatch(popupHtml, /class="mark"/);

  const permissions = manifest.permissions as string[];
  assert.deepEqual(
    [...permissions].sort(),
    [
      "debugger",
      "downloads",
      "scripting",
      "storage",
      "tabs",
    ].sort(),
  );
  for (const forbidden of [
    "cookies",
    "webRequest",
    "webRequestBlocking",
    "clipboardRead",
    "clipboardWrite",
    "nativeMessaging",
    "history",
  ]) {
    assert.equal(permissions.includes(forbidden), false);
  }

  assert.deepEqual(manifest.host_permissions, [
    "http://*/*",
    "https://*/*",
  ]);
});
