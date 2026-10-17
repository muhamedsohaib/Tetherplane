import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import os from "node:os";
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

type DeviceRegistryOptions = {
  stateFile?: string;
  pairingTtlMs?: number;
  maxPendingPairings?: number;
  approvalRateLimit?: { maxAttempts: number; windowMs: number };
};

export class DeviceRegistry {
  readonly #stateFile: string | null;
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #pendingByCode = new Map<string, PendingPairing>();
  readonly #pendingByDevice = new Map<string, PendingPairing>();
  readonly #pairingTtlMs: number;
  #mutationQueue: Promise<void> = Promise.resolve();
  #stateOwner: Server | null = null;
  #closed = false;
  #closePromise: Promise<void> | null = null;
  readonly #maxPendingPairings: number;
  readonly #approvalLimit: { maxAttempts: number; windowMs: number };
  readonly #approvalAttempts = new Map<string, { count: number; expiresAt: number }>();

  private constructor(options: DeviceRegistryOptions) {
    this.#stateFile = options.stateFile ?? null;
    this.#pairingTtlMs = options.pairingTtlMs ?? 10 * 60_000;
    this.#maxPendingPairings = options.maxPendingPairings ?? 1024;
    this.#approvalLimit = options.approvalRateLimit ?? { maxAttempts: 20, windowMs: 60_000 };
    for (const limit of [this.#pairingTtlMs, this.#maxPendingPairings, this.#approvalLimit.maxAttempts, this.#approvalLimit.windowMs]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("pairing limits must be positive safe integers");
    }
  }

  static async open(
    options: DeviceRegistryOptions = {},
  ): Promise<DeviceRegistry> {
    const stateFile = options.stateFile ? await canonicalStateFile(options.stateFile) : undefined;
    const registry = new DeviceRegistry({ ...options, ...(stateFile ? { stateFile } : {}) });
    if (stateFile) registry.#stateOwner = await acquireStateOwner(stateFile);
    try {
      await registry.#load();
      return registry;
    } catch (error) {
      await registry.close();
      throw error;
    }
  }
  async startPairing(input: {
    deviceId: string;
    credentialHash: string;
  }): Promise<{
    pairingId: string;
    userCode: string;
    expiresAt: string;
  }> {
    this.#assertOpen();
    validateDeviceId(input.deviceId);
    validateCredentialHash(input.credentialHash);
    this.#pruneExpiredPairings();
    const current = this.#devices.get(input.deviceId);
    if (current && current.revokedAt === null) {
      throw new Error("device is already paired and must be revoked before re-pairing");
    }
    const earlier = this.#pendingByDevice.get(input.deviceId);
    if (earlier) {
      if (earlier.expiresAt > Date.now()) {
        throw new Error("device already has a pending pairing; approve or wait for expiry");
      }
      this.#pendingByDevice.delete(input.deviceId);
      this.#pendingByCode.delete(earlier.userCode);
    }

    if (this.#pendingByCode.size >= this.#maxPendingPairings) {
      throw new Error("pending pairing capacity limit reached; retry after existing codes expire");
    }
    let userCode: string | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = pairingCode();
      if (!this.#pendingByCode.has(candidate)) { userCode = candidate; break; }
    }
    if (!userCode) throw new Error("could not allocate a unique pairing code; retry later");
    const pending: PendingPairing = {
      pairingId: randomUUID(),
      userCode,
      deviceId: input.deviceId,
      credentialHash: input.credentialHash.toLowerCase(),
      expiresAt: Date.now() + this.#pairingTtlMs,
    };
    this.#pendingByCode.set(pending.userCode, pending);
    this.#pendingByDevice.set(pending.deviceId, pending);
    return {
      pairingId: pending.pairingId,
      userCode: pending.userCode,
      expiresAt: new Date(pending.expiresAt).toISOString(),
    };
  }

  async approvePairing(input: {
    accountId: string;
    userCode: string;
    expectedDeviceId?: string;
  }): Promise<DeviceBinding> {
    this.#assertOpen();
    validateAccountId(input.accountId);
    if (input.expectedDeviceId !== undefined) validateDeviceId(input.expectedDeviceId);
    this.#reserveApprovalAttempt(input.accountId);
    return this.#serializeMutation(async () => {
      const pending = this.#pendingByCode.get(input.userCode);
      if (!pending || pending.expiresAt <= Date.now()) {
        if (pending) {
          this.#pendingByCode.delete(input.userCode);
          if (this.#pendingByDevice.get(pending.deviceId) === pending) {
            this.#pendingByDevice.delete(pending.deviceId);
          }
        }
        throw new Error("pairing code is invalid or expired");
      }
      if (input.expectedDeviceId !== undefined && pending.deviceId !== input.expectedDeviceId) {
        throw new Error("pairing code does not match the expected device");
      }
      if (this.#pendingByDevice.get(pending.deviceId) !== pending) {
        throw new Error("pairing code is no longer active");
      }
      const current = this.#devices.get(pending.deviceId);
      if (current && current.revokedAt === null) {
        throw new Error("device is already paired and must be revoked before re-pairing");
      }

      const record: DeviceRecord = {
        deviceId: pending.deviceId,
        accountId: input.accountId,
        credentialHash: pending.credentialHash,
        pairedAt: new Date().toISOString(),
        revokedAt: null,
      };
      const nextDevices = new Map(this.#devices);
      nextDevices.set(record.deviceId, record);
      // Do not expose a device as paired until the durable write succeeds.
      await this.#persist(nextDevices);
      this.#devices.set(record.deviceId, record);
      this.#pendingByCode.delete(input.userCode);
      this.#pendingByDevice.delete(pending.deviceId);
      return publicBinding(record);
    });
  }

  peekPendingDeviceId(userCode: string): string | null {
    this.#assertOpen();
    const pending = this.#pendingByCode.get(userCode);
    if (!pending || pending.expiresAt <= Date.now()) {
      return null;
    }
    return pending.deviceId;
  }

  async authenticateDevice(
    deviceId: string,
    credential: string,
  ): Promise<string | null> {
    this.#assertOpen();
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
    this.#assertOpen();
    return this.#serializeMutation(async () => {
      const record = this.#devices.get(input.deviceId);
      if (!record || record.accountId !== input.accountId) {
        throw new Error("device is not owned by this account");
      }
      if (record.revokedAt !== null) return publicBinding(record);
      const revoked: DeviceRecord = {
        ...record,
        revokedAt: new Date().toISOString(),
      };
      const nextDevices = new Map(this.#devices);
      nextDevices.set(input.deviceId, revoked);
      // A failed write must not revoke a device in volatile state only.
      await this.#persist(nextDevices);
      this.#devices.set(input.deviceId, revoked);
      return publicBinding(revoked);
    });
  }

  getDevice(deviceId: string): DeviceBinding | null {
    this.#assertOpen();
    const record = this.#devices.get(deviceId);
    return record ? publicBinding(record) : null;
  }

  listDevices(accountId: string): DeviceBinding[] {
    this.#assertOpen();
    return [...this.#devices.values()]
      .filter((record) => record.accountId === accountId)
      .map(publicBinding);
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      // Work admitted before close must finish before another owner can load.
      await this.#mutationQueue;
      this.#devices.clear();
      this.#pendingByCode.clear();
      this.#pendingByDevice.clear();
      this.#approvalAttempts.clear();
      const owner = this.#stateOwner;
      this.#stateOwner = null;
      if (owner) await new Promise<void>((resolve, reject) => owner.close((error) => error ? reject(error) : resolve()));
    })();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("device registry is closed");
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

  #pruneExpiredPairings(): void {
    const now = Date.now();
    for (const [code, pending] of this.#pendingByCode) {
      if (pending.expiresAt <= now) {
        this.#pendingByCode.delete(code);
        if (this.#pendingByDevice.get(pending.deviceId) === pending) {
          this.#pendingByDevice.delete(pending.deviceId);
        }
      }
    }
  }

  #reserveApprovalAttempt(accountId: string): void {
    const now = Date.now();
    for (const [account, attempt] of this.#approvalAttempts) {
      if (attempt.expiresAt <= now) this.#approvalAttempts.delete(account);
    }
    let attempt = this.#approvalAttempts.get(accountId);
    if (!attempt) {
      // The limiter itself must remain bounded, including with many accounts.
      if (this.#approvalAttempts.size >= 1024) {
        throw new Error("pairing approval rate limit capacity reached; retry later");
      }
      attempt = { count: 0, expiresAt: now + this.#approvalLimit.windowMs };
      this.#approvalAttempts.set(accountId, attempt);
    }
    if (attempt.count >= this.#approvalLimit.maxAttempts) {
      throw new Error("too many pairing approval attempts; retry after the rate limit window");
    }
    attempt.count += 1;
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation);
    // A rejected write must not permanently poison the mutation queue.
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #persist(devices: Map<string, DeviceRecord>): Promise<void> {
    const stateFile = this.#stateFile;
    if (!stateFile) return;
    await mkdir(path.dirname(stateFile), { recursive: true });
    const state: RegistryState = {
      version: 1,
      devices: [...devices.values()].sort((a, b) =>
        a.deviceId.localeCompare(b.deviceId),
      ),
    };
    const temporary = `${stateFile}.tmp-${process.pid}`;
    await writeFile(
      temporary,
      JSON.stringify(state, null, 2) + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, stateFile);
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

/**
 * JSON state is local to one host and OS IPC/network namespace. It is not a
 * shared-volume, multi-host database. Canonicalize junction aliases and reject
 * a redirected leaf before choosing the ownership key or replacing the file.
 */
async function canonicalStateFile(value: string): Promise<string> {
  const absolute = path.resolve(value);
  await mkdir(path.dirname(absolute), { recursive: true });
  const parent = await realpath(path.dirname(absolute));
  const result = path.join(parent, path.basename(absolute));
  try {
    if ((await lstat(result)).isSymbolicLink()) throw new Error("device registry state file must not be a symbolic link");
  } catch (error) { if (!isMissing(error)) throw error; }
  return result;
}

async function acquireStateOwner(stateFile: string): Promise<Server> {
  const key = createHash("sha256").update(process.platform === "win32" ? stateFile.toLowerCase() : stateFile).digest("hex");
  // Both these kernel-owned IPC names disappear on process exit, including a
  // crash; never delete a stale disk lock or infer ownership from a reused PID.
  const address = process.platform === "win32"
    ? "\\\\.\\pipe\\tetherplane-registry-" + key
    : process.platform === "linux"
      ? "\0tetherplane-registry-" + key
      : path.join(os.tmpdir(), "tp-registry-" + key + ".sock");
  const owner = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    owner.once("error", (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === "EADDRINUSE"
        ? "device registry is already owned by another instance"
        : "device registry ownership could not be acquired", { cause: error }));
    });
    owner.listen({ path: address, exclusive: true }, () => resolve());
  });
  owner.unref();
  return owner;
}
