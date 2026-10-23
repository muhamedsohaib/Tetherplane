import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("B6 worker exits with failure and cleans its lab when Chromium launch fails", { timeout: 10_000 }, async t => {
  // Node is an existing executable that immediately rejects Chromium switches.
  // This exercises the actual B6 failure path without opening any browser.
  const child = spawn(process.execPath, [
    "--test-name-pattern=B6 CDP operational path",
    fileURLToPath(new URL("./operations-integration.test.ts", import.meta.url)),
  ], {
    env: { ...process.env, TETHERPLANE_CHROMIUM: process.execPath },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  child.stdout.on("data", data => { output += String(data); });
  child.stderr.on("data", data => { output += String(data); });
  const deadline = new AbortController();
  let exit: number | null | string;
  try {
    exit = await Promise.race([
      once(child, "close").then(([code]) => code as number | null),
      delay(6_000, "still running", { signal: deadline.signal }),
    ]);
  } finally { deadline.abort(); }
  assert.equal(exit, 1, "the launch failure must fail and exit, without a leaked fixture listener");
  assert.match(output, /isolated Chromium exited|failed to launch isolated Chromium/);
  assert.match(output, /B6_STAGE=cleanup-complete/);
});
