import {
  Provider,
  errors,
  type AdapterConstructor,
} from "oidc-provider";

import {
  createTetherAuthConfiguration,
} from "./config.ts";
import {
  findTetherAuthAccount,
} from "./account.ts";

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

  // Use the same canonical spelling as metadata validation, including the
  // trailing slash for a bare HTTPS origin. RFC 9207 compares issuers exactly.
  const issuer = new URL(input.issuer).toString();
  return new Provider(issuer, {
    ...policy,
    adapter: input.adapter,
    jwks: input.jwks,
    scopes: [
      "openid",
      "offline_access",
    ],
    responseTypes: ["code"],
    issueRefreshToken() {
      return true;
    },
    findAccount:
      findTetherAuthAccount,
    features: {
      ...policy.features,
      revocation: {
        enabled: true,
      },
      devInteractions: {
        enabled: false,
      },
    },
  });
}
