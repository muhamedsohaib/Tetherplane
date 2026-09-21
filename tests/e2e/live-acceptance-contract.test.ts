import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const planPath = fileURLToPath(
  new URL("../../scripts/live-acceptance-plan.json", import.meta.url),
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
