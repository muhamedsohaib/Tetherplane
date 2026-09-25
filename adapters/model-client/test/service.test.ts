import assert from "node:assert/strict";
import test from "node:test";

import {
  parseWorkerServiceConfig,
  runWorkerSupervisor,
  type ModelWorkerOutcome,
} from "../src/service.ts";

test("worker service config loads model API key only through a named environment variable", () => {
  const config = parseWorkerServiceConfig(
    [
      "--device", "Leno",
      "--model-endpoint", "http://127.0.0.1:11434/v1/chat/completions",
      "--model", "qwen3-coder",
      "--tetherd", "C:\\Tetherplane\\tetherd.exe",
      "--principal-profile", "C:\\Tetherplane\\model-worker.json",
      "--state-dir", "C:\\Tetherplane\\state",
      "--api-key-env", "TETHERPLANE_MODEL_API_KEY",
      "--allow", "C:\\Users\\Sohaib\\source",
      "--allow", "D:\\Work",
    ],
    { TETHERPLANE_MODEL_API_KEY: "secret-from-environment" },
  );

  assert.equal(config.device, "Leno");
  assert.equal(config.model, "qwen3-coder");
  assert.equal(config.apiKey, "secret-from-environment");
  assert.deepEqual(config.allowedRoots, [
    "C:\\Users\\Sohaib\\source",
    "D:\\Work",
  ]);
});

test("worker service rejects raw API-key command-line arguments", () => {
  assert.throws(
    () =>
      parseWorkerServiceConfig(
        [
          "--device", "Leno",
          "--model-endpoint", "http://127.0.0.1:11434/v1/chat/completions",
          "--model", "qwen3-coder",
          "--tetherd", "tetherd.exe",
          "--principal-profile", "principal.json",
          "--state-dir", "state",
          "--api-key", "must-not-enter-process-list",
        ],
        {},
      ),
    /api key.*environment|--api-key.*not allowed/i,
  );
});

test("worker supervisor retries a failed worker with bounded backoff", async () => {
  const attempts: number[] = [];
  const sleeps: number[] = [];
  let created = 0;

  const outcomes: Array<ModelWorkerOutcome | Error> = [
    new Error("model endpoint unavailable"),
    { status: "idle" },
  ];

  const controller = new AbortController();
  await runWorkerSupervisor({
    signal: controller.signal,
    pollIntervalMs: 500,
    minBackoffMs: 100,
    maxBackoffMs: 400,
    createWorker: async () => {
      const id = created++;
      return {
        async runOnce() {
          attempts.push(id);
          const next = outcomes.shift();
          if (next instanceof Error) throw next;
          if (!next) {
            controller.abort();
            return { status: "idle" as const };
          }
          if (next.status === "idle") controller.abort();
          return next;
        },
        async close() {},
      };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });

  assert.equal(created, 2);
  assert.deepEqual(attempts, [0, 1]);
  assert.deepEqual(sleeps, [100]);
});

test("worker supervisor stops cleanly while idle without starting another cycle", async () => {
  const controller = new AbortController();
  let calls = 0;

  await runWorkerSupervisor({
    signal: controller.signal,
    pollIntervalMs: 250,
    minBackoffMs: 100,
    maxBackoffMs: 1_000,
    createWorker: async () => ({
      async runOnce() {
        calls += 1;
        return { status: "idle" as const };
      },
      async close() {},
    }),
    sleep: async () => {
      controller.abort();
    },
  });

  assert.equal(calls, 1);
});
