import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  observeTestChromium,
  waitForTestChromiumDebugger,
  stopTestChromium,
} from "./helpers/chromium-test-lifecycle.ts";

test("exited test-owned browser exposes bounded startup error and cleans missing CDP endpoint", async () => {
  const profile = mkdtempSync(join(tmpdir(), "tether-chromium-exit-"));
  const browser = observeTestChromium(spawn(process.execPath, [
    "-e", "process.stderr.write('synthetic browser launch failed\\n'); process.exit(21)",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }));
  try {
    await assert.rejects(
      waitForTestChromiumDebugger(profile, browser, 1000),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /exit.*21/i);
        assert.match(error.message, /synthetic browser launch failed/i);
        return true;
      },
    );
    await stopTestChromium(profile, browser, "chrome.exe", 1500);
    assert.ok(browser.child.exitCode !== null || browser.child.signalCode !== null);
  } finally {
    if (browser.child.exitCode === null && browser.child.signalCode === null) browser.child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
});

test("missing CDP with a live test-owned child is bounded, terminates only that child and checks owned resources", async () => {
  const profile = mkdtempSync(join(tmpdir(), "tether-chromium-hung-"));
  const browser = observeTestChromium(spawn(process.execPath, [
    "-e", "setInterval(() => {}, 10000)",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }));
  try {
    await assert.rejects(waitForTestChromiumDebugger(profile, browser, 350), /private Chromium DevTools endpoint.*unavailable/i);
    await stopTestChromium(profile, browser, "chrome.exe", 2000);
    assert.ok(browser.child.exitCode !== null || browser.child.signalCode !== null);
  } finally {
    if (browser.child.exitCode === null && browser.child.signalCode === null) browser.child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
});
