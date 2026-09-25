import {
  randomBytes as cryptoRandomBytes,
} from "node:crypto";

type PendingProof = {
  interactionUid: string;
  userCode: string;
  expiresAt: number;
  accountId: string | null;
};

export type AuthLoginProofRegistryOptions = {
  ttlMs?: number;
  now?: () => number;
  randomBytes?: () => Buffer;
};

export class AuthLoginProofRegistry {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #randomBytes: () => Buffer;
  readonly #byInteraction = new Map<string, PendingProof>();
  readonly #byCode = new Map<string, PendingProof>();

  constructor(
    options: AuthLoginProofRegistryOptions = {},
  ) {
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#randomBytes =
      options.randomBytes ?? (() => cryptoRandomBytes(8));

    if (
      !Number.isSafeInteger(this.#ttlMs) ||
      this.#ttlMs < 1_000 ||
      this.#ttlMs > 15 * 60_000
    ) {
      throw new Error(
        "auth login proof ttl must be between 1000 and 900000 ms",
      );
    }
  }

  start(input: {
    interactionUid: string;
  }): {
    userCode: string;
    expiresAt: string;
  } {
    validateInteractionUid(input.interactionUid);
    this.#pruneExpired();

    const existing = this.#byInteraction.get(
      input.interactionUid,
    );
    if (existing) {
      throw new Error(
        "auth login proof already exists for interaction",
      );
    }

    const now = this.#now();
    const userCode = this.#uniqueUserCode();
    const proof: PendingProof = {
      interactionUid: input.interactionUid,
      userCode,
      expiresAt: now + this.#ttlMs,
      accountId: null,
    };
    this.#byInteraction.set(
      proof.interactionUid,
      proof,
    );
    this.#byCode.set(proof.userCode, proof);

    return {
      userCode,
      expiresAt: new Date(proof.expiresAt).toISOString(),
    };
  }

  approve(input: {
    interactionUid: string;
    userCode: string;
    accountId: string;
  }): void {
    validateInteractionUid(input.interactionUid);
    validateUserCode(input.userCode);
    validateAccountId(input.accountId);
    this.#pruneExpired();

    const proof = this.#byCode.get(input.userCode);
    if (
      !proof ||
      proof.interactionUid !== input.interactionUid
    ) {
      throw new Error(
        "auth login proof is invalid or expired",
      );
    }
    if (proof.accountId !== null) {
      throw new Error(
        "auth login proof is already approved",
      );
    }

    proof.accountId = input.accountId;
  }

  consume(input: {
    interactionUid: string;
    userCode: string;
  }): { accountId: string } | null {
    validateInteractionUid(input.interactionUid);
    validateUserCode(input.userCode);
    this.#pruneExpired();

    const proof = this.#byCode.get(input.userCode);
    if (
      !proof ||
      proof.interactionUid !== input.interactionUid ||
      proof.accountId === null
    ) {
      return null;
    }

    this.#delete(proof);
    return {
      accountId: proof.accountId,
    };
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const proof of this.#byInteraction.values()) {
      if (proof.expiresAt <= now) {
        this.#delete(proof);
      }
    }
  }

  #delete(proof: PendingProof): void {
    this.#byInteraction.delete(proof.interactionUid);
    this.#byCode.delete(proof.userCode);
  }

  #uniqueUserCode(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = this.#randomBytes();
      if (!Buffer.isBuffer(bytes) || bytes.length < 4) {
        throw new Error(
          "auth login proof random source returned insufficient bytes",
        );
      }
      const token = bytes
        .toString("hex")
        .toUpperCase()
        .slice(0, 8);
      const userCode =
        `${token.slice(0, 4)}-${token.slice(4, 8)}`;
      if (!this.#byCode.has(userCode)) {
        return userCode;
      }
    }
    throw new Error(
      "unable to allocate unique auth login proof code",
    );
  }
}

function validateInteractionUid(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._~-]{8,256}$/.test(value)
  ) {
    throw new Error(
      "auth login proof interaction is invalid",
    );
  }
}

function validateUserCode(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value)
  ) {
    throw new Error(
      "auth login proof code is invalid",
    );
  }
}

function validateAccountId(value: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
      value,
    )
  ) {
    throw new Error(
      "auth login proof account is invalid",
    );
  }
}
