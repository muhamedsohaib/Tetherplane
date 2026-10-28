import { BrowserPolicyError } from "./policy.ts";

/**
 * Local, in-memory test grant. It cannot be issued, extended or revoked using
 * the AI-facing browser RPC. This is NOT proof of human identity or a
 * production owner-consent interface.
 *
 * The trusted local process selects one origin and a bounded operation set.
 * The guard is rechecked before every browser action and fails closed.
 */
export const GRANTABLE_LAB_OPERATIONS = [
  "pages",
  "create_tab",
  "snapshot",
  "navigate",
  "close",
  "act",
  "wait",
] as const;

export type GrantableLabOperation =
  (typeof GRANTABLE_LAB_OPERATIONS)[number];

const MAX_LAB_GRANT_MS = 15 * 60 * 1_000;

export class LocalBrowserLabGrant {
  readonly #origin: string;
  readonly #operations: ReadonlySet<GrantableLabOperation>;
  readonly #expiresAtMs: number;
  readonly #clock: () => number;
  #revoked = false;

  constructor(
    input: {
      origin: string;
      operations: readonly GrantableLabOperation[];
      expiresAtMs: number;
    },
    clock: () => number = Date.now,
  ) {
    const origin = new URL(input.origin);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      input.origin !== origin.origin ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new TypeError("grant origin must be an exact HTTP(S) origin");
    }
    const valid = new Set<string>(GRANTABLE_LAB_OPERATIONS);
    if (
      input.operations.length === 0 ||
      input.operations.some((op) => !valid.has(op)) ||
      new Set(input.operations).size !== input.operations.length
    ) {
      throw new TypeError("grant operations must be a nonempty bounded set");
    }
    const ttl = input.expiresAtMs - clock();
    if (
      !Number.isSafeInteger(input.expiresAtMs) ||
      ttl <= 0 ||
      ttl > MAX_LAB_GRANT_MS
    ) {
      throw new TypeError("lab grant must expire within 15 minutes");
    }

    this.#origin = origin.origin;
    this.#operations = new Set(input.operations);
    this.#expiresAtMs = input.expiresAtMs;
    this.#clock = clock;
  }

  /**
   * This control is retained only by the local host, not offered as an RPC.
   */
  revoke(): void {
    this.#revoked = true;
  }

  get approvedOrigin(): string {
    return this.#origin;
  }

  get isActive(): boolean {
    return !this.#revoked && this.#clock() < this.#expiresAtMs;
  }

  operations(): string[] {
    if (!this.isActive) return [];
    return [...this.#operations];
  }

  allowsUrl(url: string): boolean {
    if (!this.isActive) return false;
    try {
      const parsed = new URL(url);
      return (
        parsed.origin === this.#origin &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }

  authorize(operation: GrantableLabOperation, url: string): void {
    if (!this.isActive || !this.#operations.has(operation) || !this.allowsUrl(url)) {
      throw new BrowserPolicyError(
        "permission_denied",
        "browser action has no active locally issued site and operation grant",
      );
    }
  }
}
