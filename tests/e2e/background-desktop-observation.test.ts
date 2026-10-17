import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyBackgroundDesktopObservation,
  readWindowsLastInputTick,
} from "./helpers/background-desktop-observation.ts";

const baseline = {
  cursorBefore: { x: 574, y: 706 },
  cursorAfter: { x: 574, y: 706 },
  foregroundBefore: 10,
  foregroundAfter: 10,
  clipboardBefore: "stable",
  clipboardAfter: "stable",
  inputTickBefore: 1000,
  inputTickAfter: 1000,
};

test("unchanged physical desktop is verified", () => {
  assert.equal(classifyBackgroundDesktopObservation(baseline), "verified");
});

test("cursor drift without input activity is a coexistence violation", () => {
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, cursorAfter: { x: 412, y: 0 },
  }), "violation");
});

test("cursor drift with intervening physical input is inconclusive, never verified", () => {
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, cursorAfter: { x: 412, y: 0 }, inputTickAfter: 1200,
  }), "inconclusive");
});

test("foreground switch without input is a violation, with input is inconclusive", () => {
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, foregroundAfter: 20,
  }), "violation");
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, foregroundAfter: 20, inputTickAfter: 1200,
  }), "inconclusive");
});

test("clipboard mutations are not silently accepted as coexistence verification", () => {
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, clipboardAfter: "changed",
  }), "violation");
  assert.equal(classifyBackgroundDesktopObservation({
    ...baseline, clipboardAfter: "changed", inputTickAfter: 1200,
  }), "inconclusive");
});

test("last-input probe supplies a bounded non-secret OS tick on Windows", {
  skip: process.platform !== "win32",
}, () => {
  const tick = readWindowsLastInputTick();
  assert.ok(Number.isSafeInteger(tick));
  assert.ok(tick >= 0 && tick <= 0xffffffff);
});
