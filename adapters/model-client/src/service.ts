import type { ModelWorkerOutcome } from "./index.ts";
export type { ModelWorkerOutcome } from "./index.ts";

export type WorkerServiceConfig = {
  device: string;
  modelEndpoint: string;
  model: string;
  tetherdPath: string;
  principalProfile: string;
  stateDir: string;
  allowedRoots: string[];
  pollIntervalMs: number;
  maxActions: number;
  leaseTtlMs: number;
  minBackoffMs: number;
  maxBackoffMs: number;
  apiKeyEnv?: string;
  apiKey?: string;
};

export type WorkerRunner = {
  runOnce(): Promise<ModelWorkerOutcome>;
  close(): Promise<void>;
};

export type WorkerSupervisorOptions = {
  signal: AbortSignal;
  pollIntervalMs: number;
  minBackoffMs: number;
  maxBackoffMs: number;
  createWorker(): Promise<WorkerRunner>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const VALUE_FLAGS = new Set([
  "--device",
  "--model-endpoint",
  "--model",
  "--tetherd",
  "--principal-profile",
  "--state-dir",
  "--allow",
  "--poll-ms",
  "--max-actions",
  "--lease-ttl-ms",
  "--min-backoff-ms",
  "--max-backoff-ms",
  "--api-key-env",
]);

export function parseWorkerServiceConfig(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): WorkerServiceConfig {
  const values = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--api-key") {
      throw new Error(
        "--api-key is not allowed; load model API keys through --api-key-env",
      );
    }
    if (!flag || !VALUE_FLAGS.has(flag)) {
      throw new Error(`unknown worker service argument: ${flag ?? ""}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    const existing = values.get(flag) ?? [];
    existing.push(value);
    values.set(flag, existing);
  }

  const device = required(values, "--device");
  const modelEndpoint = required(values, "--model-endpoint");
  const model = required(values, "--model");
  const tetherdPath = required(values, "--tetherd");
  const principalProfile = required(values, "--principal-profile");
  const stateDir = required(values, "--state-dir");
  const allowedRoots = values.get("--allow") ?? [];
  const pollIntervalMs = integer(values, "--poll-ms", 1_000, 100, 300_000);
  const maxActions = integer(values, "--max-actions", 32, 1, 1_000);
  const leaseTtlMs = integer(
    values,
    "--lease-ttl-ms",
    600_000,
    1,
    3_600_000,
  );
  const minBackoffMs = integer(
    values,
    "--min-backoff-ms",
    1_000,
    100,
    60_000,
  );
  const maxBackoffMs = integer(
    values,
    "--max-backoff-ms",
    30_000,
    minBackoffMs,
    300_000,
  );
  const apiKeyEnv = optionalSingle(values, "--api-key-env");
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
  if (apiKeyEnv && !apiKey) {
    throw new Error(
      `model API key environment variable is not set: ${apiKeyEnv}`,
    );
  }

  return {
    device,
    modelEndpoint,
    model,
    tetherdPath,
    principalProfile,
    stateDir,
    allowedRoots,
    pollIntervalMs,
    maxActions,
    leaseTtlMs,
    minBackoffMs,
    maxBackoffMs,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
}

export async function runWorkerSupervisor(
  options: WorkerSupervisorOptions,
): Promise<void> {
  validateSupervisorOptions(options);
  const sleep = options.sleep ?? abortableSleep;
  let backoffMs = options.minBackoffMs;

  while (!options.signal.aborted) {
    let worker: WorkerRunner | null = null;
    try {
      worker = await options.createWorker();

      while (!options.signal.aborted) {
        try {
          const outcome = await worker.runOnce();
          backoffMs = options.minBackoffMs;

          if (options.signal.aborted) break;
          if (outcome.status === "idle" || outcome.status === "contended") {
            await sleep(options.pollIntervalMs, options.signal);
          }
        } catch {
          if (options.signal.aborted) break;
          await worker.close().catch(() => undefined);
          worker = null;
          await sleep(backoffMs, options.signal);
          backoffMs = Math.min(options.maxBackoffMs, backoffMs * 2);
          break;
        }
      }
    } finally {
      if (worker) {
        await worker.close().catch(() => undefined);
      }
    }
  }
}

function validateSupervisorOptions(options: WorkerSupervisorOptions): void {
  for (const [name, value] of [
    ["pollIntervalMs", options.pollIntervalMs],
    ["minBackoffMs", options.minBackoffMs],
    ["maxBackoffMs", options.maxBackoffMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (options.maxBackoffMs < options.minBackoffMs) {
    throw new Error("maxBackoffMs must be greater than or equal to minBackoffMs");
  }
}

function required(values: Map<string, string[]>, flag: string): string {
  const value = optionalSingle(values, flag);
  if (!value) {
    throw new Error(`missing required worker service argument: ${flag}`);
  }
  return value;
}

function optionalSingle(
  values: Map<string, string[]>,
  flag: string,
): string | undefined {
  const candidates = values.get(flag);
  if (!candidates) return undefined;
  if (candidates.length !== 1) {
    throw new Error(`${flag} may be specified only once`);
  }
  const value = candidates[0]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a non-empty value`);
  }
  return value;
}

function integer(
  values: Map<string, string[]>,
  flag: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = optionalSingle(values, flag);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${flag} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
