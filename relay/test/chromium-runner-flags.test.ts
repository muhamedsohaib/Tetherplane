import assert from "node:assert/strict";
import test from "node:test";
import { chromiumTestLaunchArgs } from "./helpers/chromium-runner-flags.ts";

const profile = "/tmp/tether-chromium-synthetic-only";
const linux = { platform: "linux" as const, ci: true, githubActions: true, allowCiUnsandboxed: true };

test("synthetic localhost OAuth test permits CI-only Linux sandbox exception when explicitly scoped", () => {
  const flags = chromiumTestLaunchArgs(profile, linux);
  assert.ok(flags.includes("--no-sandbox"));
  assert.ok(flags.includes("--headless=new"));
  assert.ok(flags.includes("--remote-debugging-port=0"));
  assert.ok(flags.includes("--user-data-dir=" + profile));
  assert.equal(flags.at(-1), "about:blank");
});

test("Linux outside the verified hosted CI context and Windows never disable Chromium sandbox", () => {
  const cases = [
    { ...linux, ci: false },
    { ...linux, githubActions: false },
    { ...linux, allowCiUnsandboxed: false },
    { ...linux, platform: "win32" as const },
    { ...linux, platform: "darwin" as const },
  ];
  for (const conditions of cases) {
    assert.ok(!chromiumTestLaunchArgs(profile, conditions).includes("--no-sandbox"), JSON.stringify(conditions));
  }
});
