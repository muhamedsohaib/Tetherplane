import type {
  TetherAuthDeploymentConfig,
} from "./cli-config.ts";
import {
  RelayDeviceLoginProofClient,
} from "./relay-device-login.ts";
import {
  startTetherAuthService,
  type TetherAuthService,
  type TetherAuthSignalSource,
} from "./runtime.ts";
import type {
  TetherAuthListenOptions,
  TetherAuthTlsOptions,
} from "./server.ts";
import {
  createSqliteAdapter,
} from "./sqlite-adapter.ts";

export type TetherAuthProductionService =
  TetherAuthService;

export async function startTetherAuthProductionService(
  options: {
    deployment:
      TetherAuthDeploymentConfig;
    listen: TetherAuthListenOptions;
    tls?: TetherAuthTlsOptions;
    allowInsecureLocalhost?: boolean;
    signals?: TetherAuthSignalSource;
  },
): Promise<TetherAuthProductionService> {
  const storage = createSqliteAdapter({
    databasePath:
      options.deployment.databasePath,
  });

  try {
    const logins =
      new RelayDeviceLoginProofClient({
        relayUrl:
          options.deployment.relay.url,
        bridgeToken:
          options.deployment.relay
            .bridgeToken,
        allowInsecureLocalhost:
          options.deployment.relay
            .allowInsecureLocalhost,
      });

    const service =
      await startTetherAuthService(
        {
          issuer:
            options.deployment.issuer,
          resource:
            options.deployment.resource,
          interactionBasePath:
            options.deployment
              .interactionBasePath,
          jwks:
            options.deployment.jwks,
          adapter: storage.Adapter,
          logins,
          ...(options.tls
            ? {
                tls: options.tls,
              }
            : {}),
          allowInsecureLocalhost:
            options.allowInsecureLocalhost ??
            false,
        },
        options.listen,
        options.signals ?? process,
      );

    const closed =
      service.closed.finally(() => {
        storage.close();
      });

    let closePromise:
      | Promise<void>
      | null = null;

    const close = (): Promise<void> => {
      if (closePromise) {
        return closePromise;
      }
      closePromise = (async () => {
        try {
          await service.close();
        } finally {
          await closed;
        }
      })();
      return closePromise;
    };

    return {
      provider: service.provider,
      interactions:
        service.interactions,
      server: service.server,
      address: service.address,
      closed,
      close,
    };
  } catch (error) {
    storage.close();
    throw error;
  }
}
