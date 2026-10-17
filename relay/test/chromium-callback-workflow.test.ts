import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("pull-request CI isolates and requires the real Chromium OAuth callback on Windows and Ubuntu", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)),
    "utf8",
  );
  const match = /^  chromium-oauth-callback:\s*$/m.exec(source);
  assert.ok(match, "isolated OAuth Chromium CI job is required");
  const job = source.slice(match.index);
  assert.match(job, /if:\s*github\.event_name\s*==\s*'pull_request'/);
  assert.match(job, /os:\s*\[ubuntu-latest,\s*windows-latest\]/);
  assert.match(job, /TETHERPLANE_CHROMIUM_BIN/);
  assert.match(job, /TETHERPLANE_CHROMIUM_REQUIRED/);
  assert.match(job, /node --test[^\n]*relay\/test\/tether-auth-chromium\.test\.ts/);
  assert.match(job, /if\s*\(\$LASTEXITCODE\s*-ne\s*0\)/);
});

test("hosted OAuth gate installs a pinned CI Chromium binary instead of trusting runner images", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  assert.match(manifest.devDependencies?.playwright ?? "", /^\d+\.\d+\.\d+$/, "Playwright version must be exact");
  const workflow = readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8");
  const job = workflow.slice(workflow.indexOf("  chromium-oauth-callback:"));
  assert.match(job, /pnpm exec playwright install chromium/);
  assert.match(job, /chromium\.executablePath\(\)/);
  assert.doesNotMatch(job, /findInstalledChromium/);
  assert.match(job, /1\.\.10\s*\|\s*ForEach-Object/, "ten consecutive hosted OAuth flows are required");
});
