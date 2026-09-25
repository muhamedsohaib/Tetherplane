import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { ClientAuthenticator, ClientIdentity } from "./static-auth.ts";

type OidcCommonOptions = {
  issuer: string;
  audience: string;
  jwksUri: string;
  scopes: string[];
};

type OidcBindingOptions = {
  bindings: Array<ClientIdentity & { subject: string }>;
  identity?: never;
};

type OidcSubjectOptions = {
  identity: {
    strategy: "subject";
    principalPrefix: string;
  };
  bindings?: never;
};

export type OidcOptions = OidcCommonOptions &
  (OidcBindingOptions | OidcSubjectOptions);

export class OidcClientAuthenticator implements ClientAuthenticator {
  readonly #options: OidcOptions;
  readonly #key: JWTVerifyGetKey;

  constructor(options: OidcOptions, key?: JWTVerifyGetKey) {
    for (const value of [options.issuer, options.audience, options.jwksUri]) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      ) {
        throw new Error(
          "OIDC URLs must be absolute HTTPS URLs without credentials, query or fragment",
        );
      }
    }
    if (
      !options.scopes.length ||
      options.scopes.some(
        (scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope),
      )
    ) {
      throw new Error("OIDC requires non-empty valid scopes");
    }

    const hasBindings =
      "bindings" in options && options.bindings !== undefined;
    const hasSubjectIdentity =
      "identity" in options && options.identity !== undefined;

    if (hasBindings === hasSubjectIdentity) {
      throw new Error(
        "OIDC requires exactly one identity strategy: bindings or subject",
      );
    }

    if (hasBindings) {
      const seen = new Set<string>();
      const bindings = options.bindings;
      if (!bindings?.length) {
        throw new Error("OIDC requires explicit identity bindings");
      }
      for (const binding of bindings) {
        if (
          [
            binding.subject,
            binding.clientId,
            binding.accountId,
            binding.principalId,
          ].some(
            (value) =>
              typeof value !== "string" || !value.trim(),
          )
        ) {
          throw new Error(
            "OIDC identity binding fields must be non-empty strings",
          );
        }
        const id = JSON.stringify([
          binding.subject,
          binding.clientId,
        ]);
        if (seen.has(id)) {
          throw new Error("duplicate OIDC identity binding");
        }
        seen.add(id);
      }
    } else {
      const identity = options.identity;
      if (
        identity?.strategy !== "subject" ||
        typeof identity.principalPrefix !== "string" ||
        !identity.principalPrefix.trim() ||
        /[\s\x00-\x1F\x7F]/.test(identity.principalPrefix)
      ) {
        throw new Error(
          "OIDC subject identity requires a valid principalPrefix",
        );
      }
    }

    this.#options = structuredClone(options);
    this.#key =
      key ??
      createRemoteJWKSet(new URL(options.jwksUri), {
        timeoutDuration: 5_000,
      });
  }

  async authenticate(token: string): Promise<ClientIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        issuer: this.#options.issuer,
        audience: this.#options.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub"],
      });

      const scopes =
        typeof payload.scope === "string"
          ? payload.scope.split(" ")
          : [];
      if (
        !this.#options.scopes.every((scope) =>
          scopes.includes(scope),
        )
      ) {
        return null;
      }

      const client = payload.azp ?? payload.client_id;
      if (typeof client !== "string" || !client.trim()) {
        return null;
      }
      if (
        payload.azp &&
        payload.client_id &&
        payload.azp !== payload.client_id
      ) {
        return null;
      }
      if (typeof payload.sub !== "string" || !payload.sub.trim()) {
        return null;
      }

      if (
        "identity" in this.#options &&
        this.#options.identity?.strategy === "subject"
      ) {
        return {
          accountId: payload.sub,
          clientId: client,
          principalId:
            this.#options.identity.principalPrefix + payload.sub,
        };
      }

      const bindings =
        "bindings" in this.#options
          ? this.#options.bindings
          : undefined;
      const binding = bindings?.find(
        (candidate) =>
          candidate.subject === payload.sub &&
          candidate.clientId === client,
      );
      return binding
        ? {
            accountId: binding.accountId,
            clientId: binding.clientId,
            principalId: binding.principalId,
          }
        : null;
    } catch {
      // Never log token contents or provider errors, including JWKS failures.
      return null;
    }
  }
}
