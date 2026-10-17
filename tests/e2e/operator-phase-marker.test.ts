import assert from "node:assert/strict";
import test from "node:test";

import { writePhaseMarker } from "./helpers/operator-phase-marker.ts";

function errorWithCode(code: string): Error {
  return Object.assign(new Error("fixture marker unavailable"), { code });
}

test("phase-marker writer retries Windows EBUSY and preserves the requested phase", async () => {
  let attempts = 0;
  const values: string[] = [];
  await writePhaseMarker("test-owned-marker", "select", async (_file, value) => {
    attempts++;
    if (attempts <= 2) throw errorWithCode("EBUSY");
    values.push(value);
  });
  assert.equal(attempts, 3);
  assert.deepEqual(values, ["select"]);
});

test("phase-marker writer rejects non-sharing errors immediately", async () => {
  let attempts = 0;
  await assert.rejects(
    writePhaseMarker("test-owned-marker", "select", async () => {
      attempts++;
      throw errorWithCode("EACCES");
    }),
    { code: "EACCES" },
  );
  assert.equal(attempts, 1);
});

test("phase-marker writer gives up after a bounded number of EBUSY retries", {
  timeout: 3000,
}, async () => {
  let attempts = 0;
  await assert.rejects(
    writePhaseMarker("test-owned-marker", "invoke", async () => {
      attempts++;
      throw errorWithCode("EBUSY");
    }),
    { code: "EBUSY" },
  );
  assert.ok(attempts > 1 && attempts <= 40);
});
