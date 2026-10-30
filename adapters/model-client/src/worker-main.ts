#!/usr/bin/env node

import { runModelWorkerCli } from "./cli.ts";

const controller = new AbortController();

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

// The optional native GUI launcher supervises this worker in the owner session.
// When its exact parent is terminated, stop the in-flight worker and close
// the locally spawned stdio agent rather than leave orphan processes behind.
const nativeParentRaw = process.env.TETHERPLANE_MODEL_LAUNCHER_PID;
if (nativeParentRaw !== undefined) {
  const nativeParent = Number(nativeParentRaw);
  if (
    !Number.isSafeInteger(nativeParent) ||
    nativeParent <= 0 ||
    nativeParent !== process.ppid
  ) {
    throw new Error("model launcher parent binding is invalid");
  }
  const parentWatch = setInterval(() => {
    try {
      process.kill(nativeParent, 0);
    } catch {
      controller.abort();
    }
  }, 750);
  parentWatch.unref();
}

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
