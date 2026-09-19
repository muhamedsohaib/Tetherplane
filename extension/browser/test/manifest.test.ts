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
  assert.deepEqual(manifest.action, {
    default_popup: "pair.html",
  });

  const permissions = manifest.permissions as string[];
  assert.deepEqual(
    [...permissions].sort(),
    ["scripting", "storage", "tabs"].sort(),
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
