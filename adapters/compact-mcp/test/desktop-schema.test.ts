import assert from "node:assert/strict";
import test from "node:test";

import {
  listSchemaOperations,
  lookupOperationSchema,
} from "../src/schema-catalog.ts";

test("desktop schema catalog exposes semantic, clipboard, lease, and fallback operations", () => {
  assert.deepEqual(listSchemaOperations("desktop"), [
    "act",
    "foreground_lease_acquire",
    "foreground_lease_get",
    "foreground_lease_release",
    "physical_pointer_move",
    "private_clipboard_get",
    "private_clipboard_set",
    "snapshot",
  ]);

  const snapshot = lookupOperationSchema("desktop", "snapshot");
  assert.equal(snapshot?.type, "object");

  const act = lookupOperationSchema("desktop", "act") as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(act.required, ["reference", "action"]);
  assert.ok(act.properties?.from_private_clipboard);

  const physical = lookupOperationSchema(
    "desktop",
    "physical_pointer_move",
  ) as { required?: string[] };
  assert.deepEqual(physical.required, [
    "lease_id",
    "target_resource",
    "x",
    "y",
  ]);
});
