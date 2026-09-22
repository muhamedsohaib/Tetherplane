import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeCommandForPlatform } from "./live-acceptance-command.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const planPath = path.join(here, "live-acceptance-plan.json");
const plan = JSON.parse(readFileSync(planPath, "utf8"));

const modes = ["--describe", "--prepare", "--live", "--cleanup"];
const selectedModes = modes.filter((mode) => process.argv.includes(mode));

if (selectedModes.length !== 1) {
  fail(
    "select exactly one mode: --describe, --prepare, --live, or --cleanup",
  );
}

const mode = selectedModes[0];

if (mode === "--describe") {
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
  process.exit(0);
}

requireWindows();

const acceptanceRoot = path.join(
  requiredEnvironment("LOCALAPPDATA"),
  "Tetherplane",
  "live-acceptance",
  plan.release,
);
const packageDir = path.join(acceptanceRoot, "package");
const installDir = path.join(acceptanceRoot, "install");
const stateDir = path.join(acceptanceRoot, "state");
const allowDir = path.join(acceptanceRoot, "allowed");
const preparedPath = path.join(acceptanceRoot, "prepared.json");

if (mode === "--prepare") {
  prepare();
} else if (mode === "--live") {
  live();
} else if (mode === "--cleanup") {
  cleanup();
}

function prepare() {
  const sourceCommit = assertSourceTruth();

  rmSync(acceptanceRoot, { recursive: true, force: true });
  mkdirSync(allowDir, { recursive: true });

  stage("source_of_truth", () => {
    process.stdout.write("SOURCE_COMMIT=" + sourceCommit + "\n");
  });

  stage("release_package", () => {
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "package-windows.ps1"),
      "-OutputPath",
      packageDir,
    ]);
  });

  stage("isolated_install", () => {
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "install-windows.ps1"),
      "-PackagePath",
      packageDir,
      "-InstallPrefix",
      installDir,
      "-StateDir",
      stateDir,
    ]);
  });

  const installedManifest = readJson(
    path.join(installDir, "manifest.json"),
  );
  assert.equal(installedManifest.version, plan.release.slice(1));
  assert.equal(installedManifest.source_commit, sourceCommit);

  stage("installed_six_tool_smoke", () => {
    runInstalledSmoke();
  });

  run("cargo", ["build", "-p", "tetherd"]);
  run(pnpmCommand(), [
    "--filter",
    "@tetherplane/e2e",
    "build:deps",
  ]);

  writeFileSync(
    preparedPath,
    JSON.stringify(
      {
        release: plan.release,
        source_commit: sourceCommit,
        prepared_at: new Date().toISOString(),
        package_dir: packageDir,
        install_dir: installDir,
        state_dir: stateDir,
        allow_dir: allowDir,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  process.stdout.write("LIVE_ACCEPTANCE_PREPARED=True\n");
  process.stdout.write(
    "USER_PRESENCE_REQUIRED_FOR_NEXT_PHASE=True\n",
  );
}

function live() {
  if (!process.argv.includes("--user-present")) {
    fail(
      "--live requires --user-present; do not run the observed phase unattended",
    );
  }

  const sourceCommit = assertSourceTruth();
  const prepared = requirePrepared();
  assert.equal(prepared.source_commit, sourceCommit);
  assert.equal(prepared.release, plan.release);

  const installedManifest = readJson(
    path.join(installDir, "manifest.json"),
  );
  assert.equal(installedManifest.source_commit, sourceCommit);

  process.stdout.write(
    "LIVE_OBSERVATION_BEGIN=True\n" +
      "OPERATOR_EXPECTATION=Keep using a normal human-owned window; Tetherplane must not steal focus, move the physical cursor, overwrite the global clipboard, or hijack a human-owned browser tab.\n",
  );

  stage("installed_six_tool_smoke", () => {
    runInstalledSmoke();
  });

  stage("local_core", () => {
    run(process.execPath, [
      path.join(repoRoot, "scripts", "bench-local.ts"),
    ]);
  });

  stage("browser_semantic", () => {
    run(process.execPath, [
      path.join(repoRoot, "scripts", "bench-browser.ts"),
    ]);
  });

  stage("desktop_semantic", () => {
    run(process.execPath, [
      path.join(repoRoot, "scripts", "bench-desktop.ts"),
    ]);
  });

  process.stdout.write("LOCAL_LIVE_ACCEPTANCE=PASS\n");
  process.stdout.write("REMOTE_PLANE_LIVE_PROOF_REQUIRED=True\n");
  process.stdout.write("RELEASE_TAG_ALLOWED=False\n");
}

function cleanup() {
  const expectedBase = path.resolve(
    requiredEnvironment("LOCALAPPDATA"),
    "Tetherplane",
    "live-acceptance",
  );
  const resolvedRoot = path.resolve(acceptanceRoot);
  if (
    resolvedRoot !== path.join(expectedBase, plan.release) ||
    !resolvedRoot.startsWith(expectedBase + path.sep)
  ) {
    fail("refusing cleanup outside the dedicated live-acceptance root");
  }

  if (existsSync(installDir)) {
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "uninstall-windows.ps1"),
      "-InstallPrefix",
      installDir,
    ]);
  }

  rmSync(acceptanceRoot, { recursive: true, force: true });
  process.stdout.write("LIVE_ACCEPTANCE_CLEANUP=PASS\n");
}

function runInstalledSmoke() {
  run(process.execPath, [
    path.join(
      installDir,
      "adapters",
      "compact-mcp",
      "smoke-six-tools.mjs",
    ),
    "--tetherd",
    path.join(installDir, "bin", "tetherd.exe"),
    "--allow",
    allowDir,
    "--state-dir",
    stateDir,
  ]);
}

function assertSourceTruth() {
  const branch = output("git", ["branch", "--show-current"]);
  if (branch !== "main") {
    fail("live acceptance requires the main branch; found " + branch);
  }

  const dirty = output("git", ["status", "--porcelain"]);
  if (dirty !== "") {
    fail("live acceptance requires a clean working tree");
  }

  run("git", ["fetch", "origin"]);
  const head = output("git", ["rev-parse", "HEAD"]);
  const remote = output("git", ["rev-parse", "origin/main"]);
  if (head !== remote) {
    fail(
      "local HEAD must exactly match origin/main before live acceptance",
    );
  }
  return head;
}

function requirePrepared() {
  if (!existsSync(preparedPath)) {
    fail("run --prepare before --live");
  }
  return readJson(preparedPath);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function stage(id, action) {
  const stageInfo = plan.stages.find((candidate) => candidate.id === id);
  if (!stageInfo) {
    fail("acceptance plan is missing stage " + id);
  }
  process.stdout.write("STAGE_BEGIN=" + id + "\n");
  action();
  process.stdout.write("STAGE_PASS=" + id + "\n");
}

function run(command, args) {
  const normalized = normalizeCommandForPlatform(
    command,
    args,
    process.platform,
    process.env.ComSpec,
  );
  const result = spawnSync(normalized.command, normalized.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      command +
        " failed with exit code " +
        String(result.status),
    );
  }
}

function output(command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function requireWindows() {
  if (process.platform !== "win32") {
    fail("live acceptance execution currently requires Windows");
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) fail("required environment variable is missing: " + name);
  return value;
}

function fail(message) {
  throw new Error(message);
}
