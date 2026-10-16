import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows CI runs the full onboarding Pester suite after its own release build", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const binaryStep = workflow.indexOf("- name: Windows release binary");
  const pesterStep = workflow.indexOf("- name: Windows onboarding Pester acceptance");
  const smokeStep = workflow.indexOf("- name: Windows package/install smoke");

  assert.ok(binaryStep >= 0, "release binary build must be present");
  assert.ok(pesterStep > binaryStep, "full Pester gate must follow its release binary build");
  assert.ok(smokeStep > pesterStep, "package smoke must follow full Pester acceptance");
  const pesterConfig = workflow.slice(pesterStep, smokeStep);
  assert.match(pesterConfig, /if: runner\.os == 'Windows'/);
  assert.match(pesterConfig, /shell: powershell/);
  assert.match(
    pesterConfig,
    /powershell -NoProfile -ExecutionPolicy Bypass -File scripts\/run-onboarding-tests\.ps1/,
  );
});
