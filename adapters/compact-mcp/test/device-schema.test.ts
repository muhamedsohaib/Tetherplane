import assert from "node:assert/strict";
import test from "node:test";

import {
  listSchemaOperations,
  lookupOperationSchema,
} from "../src/schema-catalog.ts";

test("device schema catalog exposes status, capabilities, and pairing approval", () => {
  assert.deepEqual(listSchemaOperations("device"), [
    "approve_pairing",
    "capabilities",
    "status",
  ]);

  const approval = lookupOperationSchema("device", "approve_pairing") as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(approval.required, ["userCode", "expectedDeviceId"]);
  assert.ok(approval.properties?.userCode);
  assert.ok(approval.properties?.expectedDeviceId);
  assert.ok(!approval.properties?.accountId);
  assert.ok(!approval.properties?.principalId);
  const described = lookupOperationSchema("device", "approve_pairing") as {
    description?: string;
    "x-tetherplane-side-effect"?: string;
  };
  assert.match(described.description ?? "", /approve a pending device pairing/i);
  assert.equal(described["x-tetherplane-side-effect"], "external_mutation");
});
