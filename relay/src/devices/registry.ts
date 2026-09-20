import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type DeviceRecord = {
  deviceId: string;
  accountId: string;
  credentialHash: string;
  pairedAt: string;
  revokedAt: string | null;
};

type PendingPairing = {
  pairingId: string;
  userCode: string;
  deviceId: string;
  credentialHash: string;
  expiresAt: number;
};

type RegistryState = {
  version: 1;
  devices: DeviceRecord[];
};
export type DeviceBinding = {
  deviceId: string;
  accountId: string;
  pairedAt: string;
  revokedAt: string | null;
};

export class DeviceRegistry {
  readonly #stateFile: string | null;
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #pendingByCode = new Map<string, PendingPairing>();
  readonly #pairingTtlMs: number;

  private constructor(options: {
    stateFile?: string;
    pairingTtlMs?: number;
  }) {
    this.#stateFile = options.stateFile ?? null;
    this.#pairingTtlMs = options.pairingTtlMs ?? 10 * 60_000;
  }

  static async open(
    options: {
      stateFile?: string;
      pairingTtlMs?: number;
    } = {},
  ): Promise<DeviceRegistry> {
    const registry = new DeviceRegistry(options);
    await registry.#load();
    return registry;
  }
  async startPairing(input: {
    deviceId: string;
    credentialHash: string;
  }): Promise<{
    pairingId: string;
    userCode: string;
    expiresAt: string;
  }> {
    validateDeviceId(input.deviceId);
    validateCredentialHash(input.credentialHash);
    const current = this.#devices.get(input.deviceId);
    if (current && current.revokedAt === null) {
      throw new Error("device is already paired and must be revoked before re-pairing");
    }

    const pending: PendingPairing = {
      pairingId: randomUUID(),
      userCode: pairingCode(),
      deviceId: input.deviceId,
      credentialHash: input.credentialHash.toLowerCase(),
      expiresAt: Date.now() + this.#pairingTtlMs,
    };
    this.#pendingByCode.set(pending.userCode, pending);
    return {
      pairingId: pending.pairingId,
      userCode: pending.userCode,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  async approvePairing(input: {
    accountId: string;
    userCode: string;
  }): Promise<DeviceBinding> {
    validateAccountId(input.accountId);
    const pending = this.#pendingByCode.get(input.userCode);
    if (!pending || pending.expiresAt <= Date.now()) {
      if (pending) this.#pendingByCode.delete(input.userCode);
      throw new Error("pairing code is invalid or expired");
    }
    this.#pendingByCode.delete(input.userCode);

    const record: DeviceRecord = {
      deviceId: pending.deviceId,
      accountId: input.accountId,
      credentialHash: pending.credentialHash,
      pairedAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.#devices.set(record.deviceId, record);
    await this.#persist();
    return publicBinding(record);
  }

  async authenticateDevice(
    deviceId: string,
    credential: string,
  ): Promise<string | null> {
    const record = this.#devices.get(deviceId);
    if (
      !record ||
      record.revokedAt !== null ||
      typeof credential !== "string" ||
      credential.length < 16
    ) {
      return null;
    }
    const actual = Buffer.from(
      hashDeviceCredential(credential),
      "hex",
    );
    const expected = Buffer.from(record.credentialHash, "hex");
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return null;
    }
    return record.accountId;
  }
  async revokeDevice(input: {
    accountId: string;
    deviceId: string;
  }): Promise<DeviceBinding> {
    const record = this.#devices.get(input.deviceId);
    if (!record || record.accountId !== input.accountId) {
      throw new Error("device is not owned by this account");
    }
    if (record.revokedAt === null) {
      record.revokedAt = new Date().toISOString();
      await this.#persist();
    }
    return publicBinding(record);
  }

  getDevice(deviceId: string): DeviceBinding | null {
    const record = this.#devices.get(deviceId);
    return record ? publicBinding(record) : null;
  }

  listDevices(accountId: string): DeviceBinding[] {
    return [...this.#devices.values()]
      .filter((record) => record.accountId === accountId)
      .map(publicBinding);
  }

  async #load(): Promise<void> {
    if (!this.#stateFile) return;
    let content: string;
    try {
      content = await readFile(this.#stateFile, "utf8");
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const parsed = JSON.parse(content) as Partial<RegistryState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.devices)) {
      throw new Error("invalid relay device registry");
    }
    for (const raw of parsed.devices) {
      if (!isDeviceRecord(raw)) {
        throw new Error("invalid relay device registry record");
      }
      this.#devices.set(raw.deviceId, { ...raw });
    }
  }

  async #persist(): Promise<void> {
    if (!this.#stateFile) return;
    await mkdir(path.dirname(this.#stateFile), { recursive: true });
    const state: RegistryState = {
      version: 1,
      devices: [...this.#devices.values()].sort((a, b) =>
        a.deviceId.localeCompare(b.deviceId),
      ),
    };
    const temporary = `${this.#stateFile}.tmp-${process.pid}`;
    await writeFile(
      temporary,
      JSON.stringify(state, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, this.#stateFile);
  }
}
export function hashDeviceCredential(secret: string): string {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("device credential must contain at least 16 characters");
  }
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateDeviceCredential(): string {
  return randomBytes(32).toString("base64url");
}

function pairingCode(): string {
  const code = randomBytes(4).toString("hex").toUpperCase();
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

function publicBinding(record: DeviceRecord): DeviceBinding {
  return {
    deviceId: record.deviceId,
    accountId: record.accountId,
    pairedAt: record.pairedAt,
    revokedAt: record.revokedAt,
  };
}

function validateDeviceId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("deviceId is invalid");
  }
}
function validateAccountId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("accountId is invalid");
  }
}

function validateCredentialHash(value: string): void {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("credentialHash must be a SHA-256 hex digest");
  }
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DeviceRecord>;
  return (
    typeof record.deviceId === "string" &&
    typeof record.accountId === "string" &&
    typeof record.credentialHash === "string" &&
    /^[0-9a-f]{64}$/i.test(record.credentialHash) &&
    typeof record.pairedAt === "string" &&
    (record.revokedAt === null ||
      typeof record.revokedAt === "string")
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
