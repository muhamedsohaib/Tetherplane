import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const scenario of ["verified", "alive", "unknown", "missing"] as const) {
  test(`startup experiment ${scenario === "verified" ? "accepts verified" : "rejects " + scenario} cleanup`, { timeout: 10_000 }, async t => {
    // Mock only the external browser boundary; exercise the real experiment's
    // decision and process exit. No browser/process is deliberately leaked.
    const event = { stage: "cleanup", elapsed_ms: 1, spawned: true, exited: false,
      closed: false, exit_code: null, signal: null, endpoint: "valid",
      stderr_bytes: 0, stderr_capped: false, stderr_categories: [],
      profile_removed: true,
      launcher_stopped: scenario === "unknown" ? null : scenario === "verified",
      browser_process_stopped: scenario === "unknown" ? null : scenario === "verified" };
    const source = `import { mock } from "node:test";
      process.argv[2] = "1";
      const fixture = mock.module("./src/cdp-control.ts", { namedExports: {
        launchCdpOwnedBrowser: async options => ({close: async () => {
          ${scenario === "missing" ? "" : "options.onStartupDiagnostic(" + JSON.stringify(event) + ");"}
        }})
      }});
      try { await import("./test-support/startup-contention-probe.ts"); }
      finally { fixture.restore(); }`;
    const child = spawn(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", source], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout = (stdout + String(data)).slice(0, 16_384); });
    child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(0, 16_384); });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("probe fixture failed to exit")); }, 5_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolve(code); });
    });
    const row = stdout.split(/\r?\n/).find(line => line.startsWith("CDP_PROBE_RESULT="));
    assert.ok(row, stderr);
    const result = JSON.parse(row.slice("CDP_PROBE_RESULT=".length));
    assert.equal(result.passed, scenario === "verified");
    assert.equal(code, scenario === "verified" ? 0 : 1);
  });
}
