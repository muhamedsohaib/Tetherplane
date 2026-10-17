import assert from "node:assert/strict";
import test from "node:test";

import { hasActionPhaseOverlap, operatorAcceptanceAllowed, operatorAcceptanceHostAllowed, type OperatorAcceptanceInput } from "./helpers/operator-acceptance-gate.ts";

const sha = "a".repeat(40);
const now = Date.UTC(2026, 9, 17, 10, 0, 0);
const valid: OperatorAcceptanceInput = {
  interactive: "1",
  operatorActive: "1",
  deadline: new Date(now + 7 * 60_000).toISOString(),
  approvedSha: sha,
};

test("operator activity may only run on the explicitly authorized Leno device", () => {
  assert.equal(operatorAcceptanceHostAllowed("Leno"), true);
  assert.equal(operatorAcceptanceHostAllowed("LENO"), true);
  assert.equal(operatorAcceptanceHostAllowed("Surface"), false);
  assert.equal(operatorAcceptanceHostAllowed(""), false);
});

test("operator activity test is disabled unless both opt-in switches are set", () => {
  assert.equal(operatorAcceptanceAllowed({ ...valid, interactive: undefined }, sha, now), false);
  assert.equal(operatorAcceptanceAllowed({ ...valid, operatorActive: undefined }, sha, now), false);
  assert.equal(operatorAcceptanceAllowed({ ...valid, interactive: "yes" }, sha, now), false);
});

test("operator activity test rejects absent, expired or unreasonable approval windows", () => {
  assert.equal(operatorAcceptanceAllowed({ ...valid, deadline: undefined }, sha, now), false);
  assert.equal(operatorAcceptanceAllowed({ ...valid, deadline: "invalid" }, sha, now), false);
  assert.equal(operatorAcceptanceAllowed({ ...valid, deadline: new Date(now - 1).toISOString() }, sha, now), false);
  assert.equal(operatorAcceptanceAllowed({ ...valid, deadline: new Date(now + 20 * 60_000).toISOString() }, sha, now), false);
  assert.equal(operatorAcceptanceAllowed({ ...valid, deadline: new Date(now + 30_000).toISOString() }, sha, now), false);
});

test("operator activity test rejects mismatched candidate SHAs", () => {
  assert.equal(operatorAcceptanceAllowed({ ...valid, approvedSha: "b".repeat(40) }, sha, now), false);
  assert.equal(operatorAcceptanceAllowed({ ...valid, approvedSha: "short" }, sha, now), false);
});

test("operator overlap requires sustained cursor motion and input changes inside one action phase", () => {
  const phase = (sample_count: number, cursor_motion_samples: number, input_change_samples: number) =>
    ({ sample_count, cursor_motion_samples, input_change_samples, first_sample_ms: 110, last_sample_ms: 190 });
  const intervals = Object.fromEntries(["set_value", "invoke", "select"].map((phase) =>
    [phase, { started_at_ms: 100, finished_at_ms: 200 }]));
  assert.equal(hasActionPhaseOverlap({
    baseline: phase(20, 20, 20),
    set_value: phase(0, 0, 0),
    invoke: phase(0, 0, 0),
    select: phase(0, 0, 0),
  }, intervals), false, "movement before actions does not count");
  assert.equal(hasActionPhaseOverlap({
    set_value: phase(1, 1, 1),
    invoke: phase(1, 1, 1),
    select: phase(1, 1, 1),
  }, intervals), false, "one late sample per action cannot certify concurrency");
  assert.equal(hasActionPhaseOverlap({
    set_value: phase(0, 0, 0),
    invoke: phase(5, 3, 3),
    select: phase(0, 0, 0),
  }, intervals), true, "one sustained interval during an actual RPC qualifies");
});

test("operator activity test permits only a matching short-lived, explicitly gated candidate", () => {
  assert.equal(operatorAcceptanceAllowed(valid, sha, now), true);
  assert.equal(operatorAcceptanceAllowed(valid, sha, now + 2 * 60_000), true);
});

test("operator overlap excludes samples outside the actual semantic RPC interval", () => {
  const metrics = {
    invoke: {
      sample_count: 4, cursor_motion_samples: 4, input_change_samples: 4,
      first_sample_ms: 50, last_sample_ms: 110,
    },
  };
  const intervals = { invoke: { started_at_ms: 100, finished_at_ms: 200 } };
  assert.equal(hasActionPhaseOverlap(metrics, intervals), false,
    "movement during phase acknowledgment must not count as concurrent RPC activity");
  assert.equal(hasActionPhaseOverlap({
    invoke: { ...metrics.invoke, first_sample_ms: 110, last_sample_ms: 210 },
  }, intervals), false, "movement after the RPC must not count");
  assert.equal(hasActionPhaseOverlap({
    invoke: { ...metrics.invoke, first_sample_ms: 110, last_sample_ms: 190 },
  }, intervals), true, "sustained samples wholly inside the real RPC qualify");
  assert.equal(hasActionPhaseOverlap({
    invoke: { sample_count: 4, cursor_motion_samples: 4, input_change_samples: 4 },
  }, intervals), false, "missing timing evidence must not certify concurrency");
});
