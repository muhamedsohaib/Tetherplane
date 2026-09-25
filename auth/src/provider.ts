import {
  Provider,
  errors,
  type AdapterConstructor,
} from "oidc-provider";

import {
  createTetherAuthConfiguration,
} from "./config.ts";

export type TetherAuthProviderInput = {
  issuer: string;
  resource: string;
  interactionBasePath: string;
  jwks: {
    keys: Array<Record<string, unknown>>;
  };
  adapter: AdapterConstructor;
};

export function createTetherAuthProvider(
  input: TetherAuthProviderInput,
): Provider {
  if (typeof input.adapter !== "function") {
    throw new Error(
      "tether-auth requires an explicit persistent adapter",
    );
  }
  if (
    !input.jwks ||
    !Array.isArray(input.jwks.keys) ||
    input.jwks.keys.length === 0
  ) {
    throw new Error(
      "tether-auth requires explicit JWKS signing keys",
    );
  }

  const policy = createTetherAuthConfiguration({
    issuer: input.issuer,
    resource: input.resource,
    interactionBasePath: input.interactionBasePath,
    invalidTarget: () => new errors.InvalidTarget(),
  });

  return new Provider(input.issuer, {
    ...policy,
    adapter: input.adapter,
    jwks: input.jwks,
    scopes: [
      "openid",
      "offline_access",
      "tetherplane:access",
    ],
    responseTypes: ["code"],
    issueRefreshToken() {
      return true;
    },
    async findAccount() {
      // Account discovery remains closed until device-assisted
      // interactions prove a paired Tetherplane account.
      return undefined;
    },
    features: {
      ...policy.features,
      devInteractions: {
        enabled: false,
      },
    },
  });
}
