import type { JWTVerifyGetKey } from "jose";
import {
  OidcClientAuthenticator,
  type OidcOptions,
} from "./oidc-auth.ts";
import {
  StaticClientAuthenticator,
  type ClientAuthenticator,
  type ClientIdentity,
  type StaticClientCredential,
} from "./static-auth.ts";

export type CompositeAuthOptions = {
  staticCredentials: StaticClientCredential[];
  oidcOptions: OidcOptions;
  oidcKey?: JWTVerifyGetKey;
};

export class CompositeClientAuthenticator implements ClientAuthenticator {
  readonly #static: StaticClientAuthenticator;
  readonly #oidc: OidcClientAuthenticator;

  constructor(options: CompositeAuthOptions) {
    if (!options.staticCredentials.length) {
      throw new Error(
        "hybrid auth requires a non-empty static clients array",
      );
    }
    const staticClientIds = new Set<string>();
    for (const credential of options.staticCredentials) {
      staticClientIds.add(credential.clientId);
    }
    for (const binding of options.oidcOptions.bindings) {
      if (staticClientIds.has(binding.clientId)) {
        throw new Error(
          "hybrid auth clientId collision between static and OIDC configuration",
        );
      }
    }
    this.#static = new StaticClientAuthenticator(
      options.staticCredentials,
    );
    this.#oidc = new OidcClientAuthenticator(
      options.oidcOptions,
      options.oidcKey,
    );
  }

  async authenticate(token: string): Promise<ClientIdentity | null> {
    if (!token) return null;
    const staticIdentity = await this.#static
      .authenticate(token)
      .catch(() => null);
    if (staticIdentity) return staticIdentity;
    return this.#oidc.authenticate(token).catch(() => null);
  }
}
