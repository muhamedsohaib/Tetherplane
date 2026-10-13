import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acceptanceRootPath,
  assertFreshAcceptanceRoot,
  assertOwnedAcceptanceRoot,
  writeAcceptanceOwnership,
} from "../../scripts/live-acceptance-safety.mjs";

async function withScratch(run: (base: string) => Promise<void>) {
  const base = await mkdtemp(path.join(os.tmpdir(), "tetherplane-acceptance-safety-"));
  try { await run(base); } finally { await rm(base, { recursive: true, force: true }); }
}

test("fresh acceptance preflight does not create or remove any files", async () => {
  await withScratch(async (base) => {
    const root = acceptanceRootPath(base, "v0.1.0");
    assert.equal(assertFreshAcceptanceRoot(base, "v0.1.0"), root);
    await assert.rejects(() => readFile(root), { code: "ENOENT" });
  });
});

test("prepare refuses an existing acceptance directory and preserves its data", async () => {
  await withScratch(async (base) => {
    const root = acceptanceRootPath(base, "v0.1.0");
    await mkdir(root, { recursive: true });
    const sentinel = path.join(root, "human-notes.txt");
    await writeFile(sentinel, "do-not-remove", "utf8");
    assert.throws(() => assertFreshAcceptanceRoot(base, "v0.1.0"), /already exists/);
    assert.equal(await readFile(sentinel, "utf8"), "do-not-remove");
  });
});

test("prepare refuses invalid release components and occupied file destinations", async () => {
  await withScratch(async (base) => {
    assert.throws(() => acceptanceRootPath(base, "../../Documents"), /release identifier/);
    const root = acceptanceRootPath(base, "v0.1.0");
    await mkdir(path.dirname(root), { recursive: true });
    await writeFile(root, "not-a-directory", "utf8");
    assert.throws(() => assertFreshAcceptanceRoot(base, "v0.1.0"), /already exists/);
    assert.equal(await readFile(root, "utf8"), "not-a-directory");
  });
});

test("explicit cleanup requires an exact Tetherplane ownership receipt", async () => {
  await withScratch(async (base) => {
    const root = acceptanceRootPath(base, "v0.1.0");
    await mkdir(root, { recursive: true });
    assert.throws(() => assertOwnedAcceptanceRoot(base, "v0.1.0"), /ownership receipt/);
    writeAcceptanceOwnership(root, "v0.1.0");
    assert.equal(assertOwnedAcceptanceRoot(base, "v0.1.0"), root);
    assert.throws(() => writeAcceptanceOwnership(root, "v0.1.0"), /EEXIST/);
    const marker = path.join(root, ".tetherplane-acceptance-owner.json");
    await writeFile(marker, JSON.stringify({ kind: "other", release: "v0.1.0", root }), "utf8");
    assert.throws(() => assertOwnedAcceptanceRoot(base, "v0.1.0"), /ownership receipt/);
  });
});

test("preparation and cleanup reject a symbolic-link parent", async (t) => {
  await withScratch(async (base) => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "tetherplane-not-owned-"));
    try {
      try { await symlink(elsewhere, path.join(base, "Tetherplane"), "junction"); }
      catch (error) {
        if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
          t.skip("host denies creation of test junction");
          return;
        }
        throw error;
      }
      assert.throws(() => assertFreshAcceptanceRoot(base, "v0.1.0"), /symbolic link|reparse point/);
      assert.throws(() => assertOwnedAcceptanceRoot(base, "v0.1.0"), /symbolic link|reparse point/);
    } finally { await rm(elsewhere, { recursive: true, force: true }); }
  });
});

test("cleanup refuses symlinked installed content even with valid owner receipt", async (t) => {
  await withScratch(async (base) => {
    const root = acceptanceRootPath(base, "v0.1.0");
    await mkdir(root, { recursive: true });
    writeAcceptanceOwnership(root, "v0.1.0");
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "tetherplane-not-owned-"));
    try {
      try { await symlink(elsewhere, path.join(root, "install"), "junction"); }
      catch (error) {
        if (error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
          t.skip("host denies creation of test junction");
          return;
        }
        throw error;
      }
      assert.throws(() => assertOwnedAcceptanceRoot(base, "v0.1.0"), /symbolic link|reparse point/);
    } finally { await rm(elsewhere, { recursive: true, force: true }); }
  });
});

test("live runner refuses overwrite and verifies ownership before cleanup", async () => {
  const runner = await readFile(new URL("../../scripts/live-acceptance.mjs", import.meta.url), "utf8");
  const prepare = runner.split("function prepare() {")[1]?.split("function live() {")[0] ?? "";
  const cleanup = runner.split("function cleanup() {")[1]?.split("function runInstalledSmoke() {")[0] ?? "";
  assert.match(prepare, /assertFreshAcceptanceRoot/);
  assert.doesNotMatch(prepare, /rmSync\s*\(/);
  assert.match(prepare, /writeAcceptanceOwnership/);
  const validate = cleanup.indexOf("assertOwnedAcceptanceRoot");
  const remove = cleanup.indexOf("rmSync(acceptanceRoot");
  assert.ok(validate >= 0 && remove > validate, "ownership guard must precede recursive cleanup");
});
