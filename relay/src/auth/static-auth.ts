import { createHash } from "node:crypto";

export type ClientIdentity = {
  accountId: string;
  clientId: string;
  principalId: string;
};

export interface ClientAuthenticator {
  authenticate(token: string): Promise<ClientIdentity | null>;
}

export type StaticClientCredential = ClientIdentity & {
  token: string;
};

export class StaticClientAuthenticator
  implements ClientAuthenticator
{
  readonly #identities = new Map<string, ClientIdentity>();

  constructor(credentials: StaticClientCredential[]) {
    const seenTokens = new Set<string>();
    const clientOwners = new Map<
      string,
      { accountId: string; principalId: string }
    >();
    for (const credential of credentials) {
      if (!credential.token) {
        throw new Error("static client token must not be empty");
      }
      const hash = tokenHash(credential.token);
      if (seenTokens.has(hash)) {
        throw new Error(
          "duplicate static client token configuration",
        );
      }
      seenTokens.add(hash);
      const owner = clientOwners.get(credential.clientId);
      if (
        owner &&
        (owner.accountId !== credential.accountId ||
          owner.principalId !== credential.principalId)
      ) {
        throw new Error(
          "ambiguous static client identity configuration",
        );
      }
      if (!owner) {
        clientOwners.set(credential.clientId, {
          accountId: credential.accountId,
          principalId: credential.principalId,
        });
      }
      this.#identities.set(hash, {
        accountId: credential.accountId,
        clientId: credential.clientId,
        principalId: credential.principalId,
      });
    }
  }

  async authenticate(
    token: string,
  ): Promise<ClientIdentity | null> {
    if (!token) return null;
    const identity = this.#identities.get(tokenHash(token));
    return identity ? { ...identity } : null;
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
