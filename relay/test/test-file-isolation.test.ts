import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("relay suite runs every test file without competing browser test workers", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: { test: string } };
  // On resource-constrained Windows hosts Chromium startup must not race
  // with parallel relay test files. Keep the full suite, no skip patterns.
  assert.equal(
    manifest.scripts.test,
    "node --test --test-concurrency=1 test/*.test.ts",
  );
});
