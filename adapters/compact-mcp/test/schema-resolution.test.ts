import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

test("canonical protocol schemas resolve through package exports", () => {
  const errorSchema = require.resolve(
    "@tetherplane/protocol/schemas/error.schema.json",
  );
  const resultSchema = require.resolve(
    "@tetherplane/protocol/schemas/result.schema.json",
  );

  assert.equal(path.basename(errorSchema), "error.schema.json");
  assert.equal(path.basename(resultSchema), "result.schema.json");
  assert.match(errorSchema.replaceAll("\\", "/"), /\/protocol\/schemas\//);
  assert.match(resultSchema.replaceAll("\\", "/"), /\/protocol\/schemas\//);
});
