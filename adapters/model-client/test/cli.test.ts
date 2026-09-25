import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { InvocationEnvelope, ResultEnvelope } from "@tetherplane/protocol";

import {
  runModelWorkerCli,
  type WorkerCliDependencies,
} from "../src/cli.ts";

test("model worker CLI wires launch-bound tetherd and env-only model credentials", async () => {
  const spawned: Array<{ tetherdPath: string; tetherdArgs: string[] }> = [];
  const models: Array<{ endpoint: string; model: string; apiKey?: string }> = [];
  let closed = 0;

  const agent = {
    async call(invocation: InvocationEnvelope): Promise<ResultEnvelope> {
      assert.equal(invocation.capability, "job.list");
      return {
        protocol_version: "1.0",
        request_id: invocation.request_id,
        status: "success",
        data: { jobs: [] },
        delta: null,
        error: null,
        verification: "verified",
        continuation: null,
        policy: null,
        timing: { duration_ms: 1 },
      };
    },
    async close() {
      closed += 1;
    },
  };

  const dependencies: WorkerCliDependencies = {
    async spawnAgent(options) {
      spawned.push(options);
      return agent;
    },
    createModel(options) {
      models.push(options);
      return {
        async nextAction() {
          throw new Error("model must not be called for an idle queue");
        },
      };
    },
    async runSupervisor(options) {
      const worker = await options.createWorker();
      const outcome = await worker.runOnce();
      assert.deepEqual(outcome, { status: "idle" });
      await worker.close();
    },
  };

  await runModelWorkerCli(
    [
      "--device", "Leno",
      "--model-endpoint", "http://127.0.0.1:11434/v1/chat/completions",
      "--model", "qwen3-coder",
      "--tetherd", "C:\\Tetherplane\\tetherd.exe",
      "--principal-profile", "C:\\Tetherplane\\model-worker.json",
      "--state-dir", "C:\\Tetherplane\\state",
      "--allow", "C:\\Users\\Sohaib\\source",
      "--api-key-env", "TETHERPLANE_MODEL_API_KEY",
    ],
    { TETHERPLANE_MODEL_API_KEY: "environment-only-secret" },
    new AbortController().signal,
    dependencies,
  );

  assert.deepEqual(spawned, [
    {
      tetherdPath: "C:\\Tetherplane\\tetherd.exe",
      tetherdArgs: [
        "--principal-profile",
        "C:\\Tetherplane\\model-worker.json",
        "--state-dir",
        "C:\\Tetherplane\\state",
        "--allow",
        "C:\\Users\\Sohaib\\source",
      ],
    },
  ]);
  assert.deepEqual(models, [
    {
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      model: "qwen3-coder",
      apiKey: "environment-only-secret",
    },
  ]);
  assert.equal(closed, 1);
});

test("model-client package exposes a tether-model-worker executable", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJson = JSON.parse(
    await readFile(path.resolve(here, "..", "package.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(packageJson.bin, {
    "tether-model-worker": "./dist/worker-main.js",
  });
});
