import type {
  TetherAuthGrantStore,
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
        return details;
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
