import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const extensionRoot =
  path.resolve(import.meta.dirname, "..");

for (const entry of ["background.js", "pair.js"]) {
  test(`${entry} is browser-loadable without workspace imports`, async () => {
    const source = await readFile(
      path.join(extensionRoot, "dist", entry),
      "utf8",
    );

    assert.doesNotMatch(
      source,
      /(?:from\s*|import\s*\()"@tetherplane\//,
      `${entry} still contains a bare Tetherplane workspace import`,
    );
  });
}