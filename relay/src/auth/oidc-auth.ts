import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { ClientAuthenticator, ClientIdentity } from "./static-auth.ts";

export type OidcOptions = {
  issuer: string;
  audience: string;
  jwksUri: string;
  scopes: string[];
  bindings: Array<ClientIdentity & { subject: string }>;
};

export class OidcClientAuthenticator implements ClientAuthenticator {
  readonly #options: OidcOptions;
  readonly #key: JWTVerifyGetKey;

  constructor(options: OidcOptions, key?: JWTVerifyGetKey) {
    for (const value of [options.issuer, options.audience, options.jwksUri]) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
        throw new Error("OIDC URLs must be absolute HTTPS URLs without credentials, query or fragment");
      }
    }
    if (!options.scopes.length || options.scopes.some(s => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(s))) {
      throw new Error("OIDC requires non-empty valid scopes");
    }
    const seen = new Set<string>();
    if (!options.bindings.length) throw new Error("OIDC requires explicit identity bindings");
    for (const binding of options.bindings) {
      if ([binding.subject, binding.clientId, binding.accountId, binding.principalId].some(v => typeof v !== "string" || !v.trim())) {
        throw new Error("OIDC identity binding fields must be non-empty strings");
      }
      const id = JSON.stringify([binding.subject, binding.clientId]);
      if (seen.has(id)) throw new Error("duplicate OIDC identity binding");
      seen.add(id);
    }
    this.#options = structuredClone(options);
    this.#key = key ?? createRemoteJWKSet(new URL(options.jwksUri), { timeoutDuration: 5_000 });
  }

  async authenticate(token: string): Promise<ClientIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        issuer: this.#options.issuer,
        audience: this.#options.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "sub"],
      });
      const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
      if (!this.#options.scopes.every(scope => scopes.includes(scope))) return null;
      const client = payload.azp ?? payload.client_id;
      if (typeof client !== "string") return null;
      if (payload.azp && payload.client_id && payload.azp !== payload.client_id) return null;
      const binding = this.#options.bindings.find(b => b.subject === payload.sub && b.clientId === client);
      return binding ? { accountId: binding.accountId, clientId: binding.clientId, principalId: binding.principalId } : null;
    } catch {
      // Never log token contents or provider errors, including JWKS failures.
      return null;
    }
  }
}
