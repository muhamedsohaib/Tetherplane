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
    for (const credential of credentials) {
      if (!credential.token) {
        throw new Error("static client token must not be empty");
      }
      this.#identities.set(tokenHash(credential.token), {
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
