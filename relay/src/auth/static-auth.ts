import { createHash } from "node:crypto";

export type ClientIdentityRole = "owner" | "operator";

export type ClientIdentity = {
  accountId: string;
  clientId: string;
  principalId: string;
  role?: ClientIdentityRole;
};

export interface ClientAuthenticator {
  authenticate(token: string): Promise<ClientIdentity | null>;
}

export type StaticClientCredential = ClientIdentity & {
  token: string;
};

export const RESERVED_NON_OWNER_PRINCIPAL_PREFIXES = [
  "operator:",
  "external:",
  "guest:",
  "unpaired:",
  "service:",
  "client:",
] as const;

export function hasNonOwnerPrincipalPrefix(principalId: string): boolean {
  const normalized = principalId.trim().toLowerCase();
  return RESERVED_NON_OWNER_PRINCIPAL_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

export function validateConfiguredIdentityRole(
  principalId: string,
  role?: ClientIdentityRole,
  context = "client identity",
): void {
  if (role !== undefined && role !== "owner" && role !== "operator") {
    throw new Error(`${context} role must be 'owner' or 'operator'`);
  }
  if (role === "owner" && hasNonOwnerPrincipalPrefix(principalId)) {
    throw new Error(
      `${context} cannot assign owner role to reserved non-owner principal prefix (${principalId})`,
    );
  }
}

export function isAuthorizedOwnerIdentity(
  identity: ClientIdentity | null | undefined,
  expectedOwnerPrincipalId?: string,
): boolean {
  if (!identity) return false;
  const accountId = identity.accountId.trim();
  const principalId = identity.principalId.trim();
  if (!accountId || !principalId) return false;
  if (hasNonOwnerPrincipalPrefix(principalId)) return false;
  if (identity.role === "operator") return false;

  const canonicalOwner = `human:${accountId}`;
  const isOwnerClaim =
    identity.role === "owner" || principalId === canonicalOwner;
  if (!isOwnerClaim) return false;

  if (expectedOwnerPrincipalId !== undefined) {
    return (
      principalId === expectedOwnerPrincipalId ||
      principalId === canonicalOwner
    );
  }
  return true;
}

export class StaticClientAuthenticator
  implements ClientAuthenticator
{
  readonly #identities = new Map<string, ClientIdentity>();

  constructor(credentials: StaticClientCredential[]) {
    for (const credential of credentials) {
      if (!credential.token) {
        throw new Error("static client token must not be empty");
      }
      validateConfiguredIdentityRole(
        credential.principalId,
        credential.role,
        "static client credential",
      );
      this.#identities.set(tokenHash(credential.token), {
        accountId: credential.accountId,
        clientId: credential.clientId,
        principalId: credential.principalId,
        ...(credential.role ? { role: credential.role } : {}),
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
