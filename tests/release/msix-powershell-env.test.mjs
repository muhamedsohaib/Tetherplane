import assert from "node:assert/strict";
import test from "node:test";
import { windowsPowerShell51Environment } from "../../scripts/msix/windows-powershell-env.mjs";

const input = {
  USERPROFILE: "C:\\Users\\runneradmin",
  ProgramFiles: "C:\\Program Files",
  SystemRoot: "C:\\Windows",
  PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules;C:\\Users\\runneradmin\\Documents\\PowerShell\\Modules",
  NODE_ENV: "test",
};

test("spawns Windows PowerShell 5.1 only with its own known module search paths", () => {
  const env = windowsPowerShell51Environment(input);
  assert.equal(env.PSModulePath,
    "C:\\Users\\runneradmin\\Documents\\WindowsPowerShell\\Modules;" +
    "C:\\Program Files\\WindowsPowerShell\\Modules;" +
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
  assert.doesNotMatch(env.PSModulePath, /\\PowerShell\\7\\|\\Documents\\PowerShell\\Modules/i);
  assert.equal(env.NODE_ENV, "test");
  assert.match(input.PSModulePath, /\\PowerShell\\7\\Modules/);
});

test("removes duplicate mixed-case module-path environment keys without changing caller", () => {
  const mixed = { ...input, psmodulepath: "C:\\other", PSMODULEPATH: "C:\\extra" };
  const out = windowsPowerShell51Environment(mixed);
  assert.equal(Object.keys(out).filter(k => k.toLowerCase() === "psmodulepath").length, 1);
  assert.equal(mixed.PSModulePath, input.PSModulePath);
  assert.equal(mixed.psmodulepath, "C:\\other");
});

test("fails closed rather than guessing missing host path roots", () => {
  const missing = { ...input };
  delete missing.SystemRoot;
  assert.throws(() => windowsPowerShell51Environment(missing), /Missing Windows PowerShell prerequisite: SystemRoot/);
});
