import {
  LocalAgentClient,
  OpenAICompatibleModelClient,
  TetherplaneModelWorker,
  type AgentTransport,
  type ModelActionSource,
} from "./index.ts";
import {
  parseWorkerServiceConfig,
  runWorkerSupervisor,
  type WorkerSupervisorOptions,
} from "./service.ts";

type ClosableAgent = AgentTransport & {
  close(): Promise<void>;
};

type SpawnAgentOptions = {
  tetherdPath: string;
  tetherdArgs: string[];
};

type ModelFactoryOptions = {
  endpoint: string;
  model: string;
  apiKey?: string;
};

export type WorkerCliDependencies = {
  spawnAgent(options: SpawnAgentOptions): Promise<ClosableAgent>;
  createModel(options: ModelFactoryOptions): ModelActionSource;
  runSupervisor(options: WorkerSupervisorOptions): Promise<void>;
};

const defaultDependencies: WorkerCliDependencies = {
  spawnAgent: (options) => LocalAgentClient.spawn(options),
  createModel: (options) => new OpenAICompatibleModelClient(options),
  runSupervisor: (options) => runWorkerSupervisor(options),
};

export async function runModelWorkerCli(
  args: string[],
  environment: Record<string, string | undefined>,
  signal: AbortSignal,
  dependencies: WorkerCliDependencies = defaultDependencies,
): Promise<void> {
  const config = parseWorkerServiceConfig(args, environment);

  await dependencies.runSupervisor({
    signal,
    pollIntervalMs: config.pollIntervalMs,
    minBackoffMs: config.minBackoffMs,
    maxBackoffMs: config.maxBackoffMs,
    createWorker: async () => {
      const tetherdArgs = [
        "--principal-profile",
        config.principalProfile,
        "--state-dir",
        config.stateDir,
      ];
      for (const root of config.allowedRoots) {
        tetherdArgs.push("--allow", root);
      }

      const agent = await dependencies.spawnAgent({
        tetherdPath: config.tetherdPath,
        tetherdArgs,
      });

      try {
        const model = dependencies.createModel({
          endpoint: config.modelEndpoint,
          model: config.model,
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        });
        const worker = new TetherplaneModelWorker({
          model,
          agent,
          device: config.device,
          maxActions: config.maxActions,
          leaseTtlMs: config.leaseTtlMs,
        });

        return {
          runOnce: () => worker.runOnce(),
          close: () => agent.close(),
        };
      } catch (error) {
        await agent.close().catch(() => undefined);
        throw error;
      }
    },
  });
}
