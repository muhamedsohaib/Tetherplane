import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { stat, utimes } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const protocolRoot = path.resolve(here, "..");
const generated = [
  path.join(protocolRoot, "generated", "types.ts"),
  path.join(protocolRoot, "generated", "types.d.ts"),
];

test("type generation does not rewrite unchanged outputs", async () => {
  const fixedTime = new Date("2026-01-01T00:00:00.000Z");
  for (const file of generated) {
    await utimes(file, fixedTime, fixedTime);
  }

  const before = await Promise.all(
    generated.map(async (file) => (await stat(file)).mtimeMs),
  );

  const result = spawnSync(
    process.execPath,
    ["scripts/generate-types.mjs"],
    {
      cwd: protocolRoot,
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    `generator failed:\n${result.stderr || result.stdout}`,
  );

  const after = await Promise.all(
    generated.map(async (file) => (await stat(file)).mtimeMs),
  );

  assert.deepEqual(
    after,
    before,
    "unchanged generated files must not be rewritten",
  );
});
