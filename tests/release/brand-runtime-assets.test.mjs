import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createWizard } from "../../packaging/msix-store-runtime/app/runtime-app.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const app = path.join(repo, "packaging", "msix-store-runtime", "app");

test("Windows setup serves only explicit branded PNG assets from its local origin", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "tetherplane-brand-runtime-"));
  let wizard;
  try {
    wizard = await createWizard({ stateRoot: state });
    const origin = new URL(wizard.url).origin;
    const checks = [
      ["assets/brand-32.png", "image/png"],
      ["assets/brand-128.png", "image/png"],
      ["setup.css", "text/css"],
      ["", "text/html"],
    ];
    for (const [name, mime] of checks) {
      const response = await fetch(origin + "/" + name);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get("content-type"), mime, name);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("content-security-policy"), /img-src 'self'/);
      const expected = await readFile(path.join(app, name || "setup.html"));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, name);
    }
    for (const name of ["assets/old-logo.png", "assets/Logo44.png", "../branding/sources/logo-black-original.png"]) {
      const r = await fetch(origin + "/" + name);
      assert.notEqual(r.status, 200, name);
    }
  } finally {
    if (wizard) await wizard.close();
    await rm(state, { recursive: true, force: true });
  }
});
