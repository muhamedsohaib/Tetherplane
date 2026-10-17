import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("required isolated Chromium callback fails rather than skipping when no browser is present", {
  timeout: 25_000,
}, () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "tetherplane-chromium-absent-"));
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      TETHERPLANE_CHROMIUM_BIN: join(fakeHome, "missing-browser.exe"),
      TETHERPLANE_CHROMIUM_REQUIRED: "1",
    };
    delete childEnv.NODE_TEST_CONTEXT;
    const target = fileURLToPath(new URL("./tether-auth-chromium.test.ts", import.meta.url));
    const result = spawnSync(process.execPath, [
      "--test",
      "--test-reporter=tap",
      "--test-name-pattern=chromium completes the browser flow",
      target,
    ], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      env: childEnv,
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, String(result.error));
    assert.notEqual(result.status, 0, "required browser must not be silently skipped: " + output.slice(-1200));
    assert.match(output, /required Chromium executable unavailable/i);
    assert.match(output, /not ok 1 - chromium completes the browser flow/i);
    assert.doesNotMatch(output, /chromium completes the browser flow[^\n]*# SKIP/i);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
