import assert from "node:assert/strict";
import test from "node:test";

import {
  listSchemaOperations,
  lookupOperationSchema,
} from "../src/schema-catalog.ts";

test("filesystem.copy has a dedicated source/destination schema without overwrite", () => {
  assert.deepEqual(lookupOperationSchema("filesystem", "copy"), {
    type: "object",
    additionalProperties: false,
    required: ["source", "destination"],
    properties: {
      source: { type: "string" },
      destination: { type: "string" },
    },
  });
  assert.ok(listSchemaOperations("filesystem").includes("copy"));
  assert.deepEqual(
    lookupOperationSchema("files", "copy"),
    lookupOperationSchema("filesystem", "copy"),
  );
});
