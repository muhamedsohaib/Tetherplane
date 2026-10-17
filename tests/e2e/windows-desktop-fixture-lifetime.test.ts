import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("background desktop fixture expires without a stop signal", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-fixture-lifetime-"));
  const statePath = path.join(temp, "state.json");
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)),
    "fixtures", "windows-desktop-fixture.ps1");
  const child = spawn("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass",
    "-File", fixturePath, "-StatePath", statePath,
    "-Title", "Tetherplane Lifetime Fixture", "-Prefix", "Lifetime",
    "-BackgroundOnly", "-LifetimeMs", "500",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(
          "background fixture exceeded its lifetime without a stop signal")), 12_000);
      }),
    ]);
    assert.equal(exitCode, 0, stderr);
    assert.equal(stderr.trim(), "", "fixture must not hide unsupported runtime APIs");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.ready, true);
    assert.equal(state.focused, false);
    assert.equal(state.pid, child.pid);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  }
});
