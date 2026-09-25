#!/usr/bin/env node

import { runModelWorkerCli } from "./cli.ts";

const controller = new AbortController();

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await runModelWorkerCli(
    process.argv.slice(2),
    process.env,
    controller.signal,
  );
} catch (error) {
  const message =
    error instanceof Error ? error.message : "model worker failed";
  process.stderr.write(`tether-model-worker: ${message}\n`);
  process.exitCode = 1;
}
