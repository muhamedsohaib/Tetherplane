import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { normalizeCommandForPlatform } from "../../scripts/live-acceptance-command.mjs";

type Stage = {
  id: string;
  phase: "prepare" | "live" | "manual" | "cleanup" | "finalize";
  automated: boolean;
  requires_user_present: boolean;
  foreground_disruptive: boolean;
  destructive: boolean;
  external_communication: boolean;
  financial: boolean;
};

type AcceptancePlan = {
  version: number;
  release: string;
  stages: Stage[];
};

const execFileAsync = promisify(execFile);
const planPath = fileURLToPath(
  new URL("../../scripts/live-acceptance-plan.json", import.meta.url),
);
const runnerPath = fileURLToPath(
  new URL("../../scripts/live-acceptance.mjs", import.meta.url),
);

test("v0.1.0 live acceptance plan is explicit and human-safe", async () => {
  const plan = JSON.parse(
    await readFile(planPath, "utf8"),
  ) as AcceptancePlan;

  assert.equal(plan.version, 1);
  assert.equal(plan.release, "v0.1.0");

  assert.deepEqual(
    plan.stages.map((stage) => stage.id),
    [
      "source_of_truth",
      "release_package",
      "isolated_install",
      "installed_six_tool_smoke",
      "local_core",
      "browser_semantic",
      "desktop_semantic",
      "remote_plane",
      "cleanup",
      "release_tag",
    ],
  );

  const prepare = plan.stages.filter(
    (stage) => stage.phase === "prepare",
  );
  assert.ok(prepare.length >= 4);
  assert.ok(
    prepare.every(
      (stage) =>
        stage.automated === true &&
        stage.requires_user_present === false,
    ),
  );

  for (const id of [
    "local_core",
    "browser_semantic",
    "desktop_semantic",
    "remote_plane",
  ]) {
    const stage = plan.stages.find((candidate) => candidate.id === id);
    assert.ok(stage, "missing stage " + id);
    assert.equal(stage.requires_user_present, true);
  }

  const remote = plan.stages.find(
    (stage) => stage.id === "remote_plane",
  );
  assert.equal(remote?.automated, false);
  assert.equal(remote?.phase, "manual");

  const releaseTag = plan.stages.find(
    (stage) => stage.id === "release_tag",
  );
  assert.equal(releaseTag?.automated, false);
  assert.equal(releaseTag?.phase, "finalize");

  for (const stage of plan.stages.filter(
    (candidate) => candidate.automated,
  )) {
    assert.equal(stage.foreground_disruptive, false);
    assert.equal(stage.destructive, false);
    assert.equal(stage.external_communication, false);
    assert.equal(stage.financial, false);
  }
});

test("live acceptance runner describes the canonical plan without side effects", async () => {
  const expected = JSON.parse(
    await readFile(planPath, "utf8"),
  ) as AcceptancePlan;

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [runnerPath, "--describe"],
    {
      encoding: "utf8",
      env: { ...process.env },
    },
  );

  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), expected);
});


test("live acceptance normalizes Windows batch commands through ComSpec", () => {
  assert.deepEqual(
    normalizeCommandForPlatform(
      "pnpm.cmd",
      ["--filter", "@tetherplane/e2e", "build:deps"],
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    ),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "pnpm.cmd",
        "--filter",
        "@tetherplane/e2e",
        "build:deps",
      ],
    },
  );

  assert.deepEqual(
    normalizeCommandForPlatform(
      "powershell.exe",
      ["-NoProfile"],
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    ),
    {
      command: "powershell.exe",
      args: ["-NoProfile"],
    },
  );

  assert.deepEqual(
    normalizeCommandForPlatform(
      "pnpm",
      ["--filter", "@tetherplane/e2e", "build:deps"],
      "linux",
      undefined,
    ),
    {
      command: "pnpm",
      args: ["--filter", "@tetherplane/e2e", "build:deps"],
    },
  );
});


test(
  "live acceptance executes a real Windows cmd shim through ComSpec",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "tetherplane cmd shim "),
    );
    const script = path.join(root, "echo-value.cmd");

    try {
      await writeFile(
        script,
        "@echo off\r\necho shim:%1\r\n",
        "utf8",
      );

      const normalized = normalizeCommandForPlatform(
        script,
        ["works"],
        process.platform,
        process.env.ComSpec,
      );

      const result = spawnSync(
        normalized.command,
        normalized.args,
        {
          encoding: "utf8",
          windowsHide: true,
        },
      );

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.trim(), "shim:works");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
