import type {
  TetherAuthGrantStore,
  TetherAuthInteractionDetails,
  TetherAuthInteractionProvider,
  TetherAuthLoginProofClient,
} from "./interaction.ts";
import {
  TetherAuthInteractionController,
} from "./interaction.ts";
import {
  createTetherAuthProvider,
  type TetherAuthProviderInput,
} from "./provider.ts";
import {
  TetherAuthServer,
  type TetherAuthAddress,
  type TetherAuthListenOptions,
  type TetherAuthTlsOptions,
} from "./server.ts";

export type TetherAuthRuntimeInput =
  TetherAuthProviderInput & {
    logins: TetherAuthLoginProofClient;
    tls?: TetherAuthTlsOptions;
    allowInsecureLocalhost?: boolean;
  };

export type TetherAuthRuntime = {
  provider: ReturnType<
    typeof createTetherAuthProvider
  >;
  interactions: TetherAuthInteractionController;
  server: TetherAuthServer;
};

export function createTetherAuthRuntime(
  input: TetherAuthRuntimeInput,
): TetherAuthRuntime {
  const provider = createTetherAuthProvider({
    issuer: input.issuer,
    resource: input.resource,
    interactionBasePath:
      input.interactionBasePath,
    jwks: input.jwks,
    adapter: input.adapter,
  });

  const interactionProvider:
    TetherAuthInteractionProvider = {
      async interactionDetails(
        request,
        response,
      ) {
        const details =
          await provider.interactionDetails(
            request,
            response,
          );
        const promptDetails =
          details.prompt.details;

        const mapped:
          TetherAuthInteractionDetails = {
            uid: details.uid,
            prompt: {
              name: details.prompt.name,
              details: {
                missingOIDCScope:
                  promptDetails[
                    "missingOIDCScope"
                  ],
                missingOIDCClaims:
                  promptDetails[
                    "missingOIDCClaims"
                  ],
                missingResourceScopes:
                  promptDetails[
                    "missingResourceScopes"
                  ],
                rar: promptDetails["rar"],
              },
            },
            params: {
              client_id:
                details.params["client_id"],
            },
            ...(details.session
              ? {
                  session: {
                    accountId:
                      details.session.accountId,
                  },
                }
              : {}),
            ...(details.grantId ===
            undefined
              ? {}
              : {
                  grantId:
                    details.grantId,
                }),
          };

        return mapped;
      },
      async interactionFinished(
        request,
        response,
        result,
        options,
      ) {
        await provider.interactionFinished(
          request,
          response,
          result,
          options,
        );
      },
    };

  const grants: TetherAuthGrantStore = {
    async find(grantId) {
      return provider.Grant.find(grantId);
    },
    create(grantInput) {
      return new provider.Grant({
        accountId: grantInput.accountId,
        clientId: grantInput.clientId,
      });
    },
  };

  const interactions =
    new TetherAuthInteractionController({
      provider: interactionProvider,
      logins: input.logins,
      resource: input.resource,
      grants,
    });

  const server = new TetherAuthServer({
    providerHandler: provider.callback(),
    interactions,
    ...(input.tls
      ? { tls: input.tls }
      : {}),
    ...(input.allowInsecureLocalhost ===
    undefined
      ? {}
      : {
          allowInsecureLocalhost:
            input.allowInsecureLocalhost,
        }),
  });

  return {
    provider,
    interactions,
    server,
  };
}


export type TetherAuthSignal =
  | "SIGINT"
  | "SIGTERM";

export type TetherAuthSignalSource = {
  once(
    signal: TetherAuthSignal,
    listener: () => void,
  ): unknown;
  off(
    signal: TetherAuthSignal,
    listener: () => void,
  ): unknown;
};

export type TetherAuthService =
  TetherAuthRuntime & {
    address: TetherAuthAddress;
    closed: Promise<void>;
    close(): Promise<void>;
  };

export async function startTetherAuthService(
  input: TetherAuthRuntimeInput,
  listen: TetherAuthListenOptions,
  signals: TetherAuthSignalSource = process,
): Promise<TetherAuthService> {
  const runtime =
    createTetherAuthRuntime(input);
  const address =
    await runtime.server.listen(listen);

  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const closed = new Promise<void>(
    (resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    },
  );

  let closePromise: Promise<void> | null =
    null;

  const removeSignalHandlers = () => {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  };

  const close = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      removeSignalHandlers();
      try {
        await runtime.server.close();
        resolveClosed();
      } catch (error) {
        rejectClosed(error);
        throw error;
      }
    })();

    return closePromise;
  };

  const onSignal = () => {
    void close().catch(() => {
      // The returned closed promise exposes shutdown failure
      // to the owning service process without logging secrets.
    });
  };

  signals.once("SIGINT", onSignal);
  signals.once("SIGTERM", onSignal);

  return {
    ...runtime,
    address,
    closed,
    close,
  };
}
