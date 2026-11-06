import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extension = path.join(repo, "extension", "browser");
const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
const workflow = await readFile(
  path.join(repo, ".github", "workflows", "browser-extension-release-lab.yml"), "utf8");
const acceptance = await readFile(
  path.join(repo, "tests", "release", "browser-real-extension-acceptance.mjs"), "utf8");

test("reviewed Edge fixture stages every manifest-required icon", async () => {
  const icons = [...new Set([
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ])];
  assert.ok(icons.length >= 4);
  for (const icon of icons) await access(path.join(extension, icon));
  assert.match(workflow, /Copy-Item -LiteralPath 'extension\\browser\\icons' -Destination \$ext -Recurse/);
  assert.match(workflow, /isolated extension manifest references an unstaged icon/);
});

test("signed Edge lab installs only into a new disposable profile through browser CDP", () => {
  assert.match(acceptance, /mkdtemp\(path\.join\(os\.tmpdir\(\), "tp-browser-real-extension-"\)\)/);
  assert.match(acceptance, /"--user-data-dir=" \+ profile/);
  assert.match(acceptance, /"Extensions\.loadUnpacked", \{path: extension\}/);
  assert.doesNotMatch(acceptance, /^\s*"--load-extension=" \+ extension,/m);
  assert.doesNotMatch(acceptance, /^\s*"--disable-extensions-except=" \+ extension,/m);
  assert.match(workflow, /Get-AuthenticodeSignature -LiteralPath \$edge/);
});

test("no real owner profile, permissions or agent is changed in the extension lab", () => {
  assert.match(acceptance, /"127\.0\.0\.1"/);
  assert.match(acceptance, /shared-authorized/);
  assert.match(acceptance, /"permission_denied"/);
  assert.match(acceptance, /stopOwnedBrowser\(\)/);
  assert.doesNotMatch(workflow, /Start-ScheduledTask|Set-ScheduledTask|Restart-Service|Stop-Service/);
});
