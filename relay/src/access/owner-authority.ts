import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { InvocationEnvelope } from "@tetherplane/protocol";
import type { ClientIdentity } from "../auth/static-auth.ts";
import type { DeviceRegistry } from "../devices/registry.ts";

export type DeviceAccessLevel = "blocked" | "observe" | "operate";

export type DeviceAccessGrant = {
  deviceId: string;
  pairedAt: string;
  clientId: string;
  principalId: string;
  level: DeviceAccessLevel;
};

type AuthorityState = {
  version: 1;
  revision: number;
  enabled: boolean;
  grants: DeviceAccessGrant[];
};

export class AuthorityError extends Error {
  constructor(
    readonly code: "permission_denied" | "invalid_arguments" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "AuthorityError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLIENT_ID = /^[^\s\x00-\x1F\x7F]{1,1024}$/u;
const PRINCIPAL_ID = /^[^\s\x00-\x1F\x7F]{1,256}$/u;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OBSERVE = new Set([
  "device.status", "device.capabilities",
  "filesystem.read", "filesystem.read_many", "filesystem.list", "filesystem.info",
  "search.start", "search.read", "search.list", "search.stop",
  "process.read", "process.list_sessions", "process.list_system",
  "browser.status", "browser.pages", "browser.snapshot", "browser.diagnostics", "browser.downloads",
  "desktop.snapshot", "desktop.private_clipboard_get", "desktop.foreground_lease_get",
  "job.get", "job.list", "audit.read",
]);
const OPERATE = new Set([
  ...OBSERVE,
  "filesystem.write", "filesystem.append", "filesystem.mkdir",
  "filesystem.move", "filesystem.patch",
  "process.run", "process.input",
  "browser.create_tab", "browser.navigate", "browser.close", "browser.act",
  "browser.wait", "browser.upload", "browser.checkpoint",
  "job.create", "job.checkpoint", "job.acquire_lease", "job.release_lease",
]);
// Deliberately excluded from relay-grant presets: process.terminate,
// human-foreground/physical desktop control, private clipboard write.
// Those remain subject to separately reviewed device-local authorization.

function validIdentity(identity: ClientIdentity): boolean {
  return ID.test(identity.accountId) && CLIENT_ID.test(identity.clientId) && PRINCIPAL_ID.test(identity.principalId);
}
function validGrant(raw: unknown): raw is DeviceAccessGrant {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const g = raw as Partial<DeviceAccessGrant>;
  return typeof g.deviceId === "string" && DEVICE_ID.test(g.deviceId)
    && typeof g.clientId === "string" && CLIENT_ID.test(g.clientId)
    && typeof g.principalId === "string" && PRINCIPAL_ID.test(g.principalId)
    && typeof g.pairedAt === "string" && !Number.isNaN(Date.parse(g.pairedAt))
    && ["blocked", "observe", "operate"].includes(g.level ?? "");
}
function key(grant: Pick<DeviceAccessGrant, "deviceId" | "clientId" | "principalId">): string {
  return JSON.stringify([grant.deviceId, grant.clientId, grant.principalId]);
}
function cloneState(s: AuthorityState): AuthorityState {
  return structuredClone(s);
}

export class OwnerDeviceAuthority {
  readonly #owner: ClientIdentity;
  readonly #registry: DeviceRegistry;
  readonly #stateFile: string | null;
  #state: AuthorityState = { version: 1, revision: 0, enabled: false, grants: [] };
  #queue: Promise<void> = Promise.resolve();
  #seen = new Map<string, { clientId: string; principalId: string; seenAt: string }>();

  private constructor(options: {owner: ClientIdentity; registry: DeviceRegistry; stateFile?: string}) {
    if (!validIdentity(options.owner)) throw new Error("owner identity must be an exact account/client/principal binding");
    this.#owner = { ...options.owner };
    this.#registry = options.registry;
    this.#stateFile = options.stateFile ?? null;
  }

  static async open(options: {owner: ClientIdentity; registry: DeviceRegistry; stateFile?: string}): Promise<OwnerDeviceAuthority> {
    const authority = new OwnerDeviceAuthority(options);
    if (authority.#stateFile) {
      let raw: string;
      try { raw = await readFile(authority.#stateFile, "utf8"); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return authority;
        throw e;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid owner authority file");
      const state = parsed as Partial<AuthorityState>;
      if (state.version !== 1 || !Number.isSafeInteger(state.revision) || (state.revision ?? -1) < 0
        || typeof state.enabled !== "boolean" || !Array.isArray(state.grants)
        || state.grants.length > 256 || state.grants.some(g => !validGrant(g))) {
        throw new Error("invalid owner authority state; refusing to start");
      }
      const keys = new Set((state.grants as DeviceAccessGrant[]).map(key));
      if (keys.size !== state.grants.length) throw new Error("duplicate authority grant; refusing to start");
      authority.#state = cloneState(state as AuthorityState);
    }
    return authority;
  }

  isOwner(identity: ClientIdentity): boolean {
    return identity.accountId === this.#owner.accountId &&
      identity.clientId === this.#owner.clientId &&
      identity.principalId === this.#owner.principalId;
  }

  observeClient(identity: ClientIdentity): void {
    if (identity.accountId !== this.#owner.accountId || !validIdentity(identity)) return;
    const k = JSON.stringify([identity.clientId, identity.principalId]);
    // Metadata only: no bearer tokens, requests or chat text.
    if (!this.#seen.has(k) && this.#seen.size >= 128) return;
    this.#seen.set(k, {
      clientId: identity.clientId,
      principalId: identity.principalId,
      seenAt: new Date().toISOString(),
    });
  }

  snapshot(identity: ClientIdentity): {
    enabled: boolean; revision: number; grants: DeviceAccessGrant[];
    clients: Array<{clientId:string;principalId:string;seenAt:string}>;
    levels: DeviceAccessLevel[]; accountId: string;
  } {
    this.#requireOwner(identity);
    this.observeClient(identity);
    return {
      enabled: this.#state.enabled,
      revision: this.#state.revision,
      grants: structuredClone(this.#state.grants),
      clients: [...this.#seen.values()].sort((a,b) => a.clientId.localeCompare(b.clientId)),
      levels: ["blocked", "observe", "operate"],
      accountId: this.#owner.accountId,
    };
  }

  async replaceGrants(identity: ClientIdentity, input: { revision: number; grants: unknown }): Promise<number> {
    this.#requireOwner(identity);
    return this.#serialize(async () => {
      this.#checkRevision(input.revision);
      if (!Array.isArray(input.grants) || input.grants.length > 256)
        throw new AuthorityError("invalid_arguments", "expected at most 256 explicit device grants");
      const result: DeviceAccessGrant[] = [];
      const seen = new Set<string>();
      for (const raw of input.grants) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new AuthorityError("invalid_arguments", "each authority grant must be an object");
        const g = raw as Record<string, unknown>;
        if (Object.keys(g).some(field => !["deviceId","clientId","principalId","level"].includes(field)))
          throw new AuthorityError("invalid_arguments", "unsupported authority grant field");
        if (typeof g.deviceId !== "string" || !DEVICE_ID.test(g.deviceId)
          || typeof g.clientId !== "string" || !CLIENT_ID.test(g.clientId)
          || typeof g.principalId !== "string" || !PRINCIPAL_ID.test(g.principalId)
          || !["blocked", "observe", "operate"].includes(String(g.level))) {
          throw new AuthorityError("invalid_arguments", "authority grant must name an exact device, client, principal and supported level");
        }
        const device = this.#registry.getDevice(g.deviceId);
        if (!device || device.accountId !== this.#owner.accountId || device.revokedAt !== null)
          throw new AuthorityError("permission_denied", "authority grant device is not currently owned by this account");
        const entry: DeviceAccessGrant = {
          deviceId: g.deviceId, clientId: g.clientId,
          principalId: g.principalId, level: g.level as DeviceAccessLevel,
          pairedAt: device.pairedAt,
        };
        const k = key(entry);
        if (seen.has(k)) throw new AuthorityError("invalid_arguments", "duplicate authority grant");
        seen.add(k);
        result.push(entry);
      }
      result.sort((a,b) => key(a).localeCompare(key(b)));
      const next: AuthorityState = {
        ...this.#state, revision: this.#state.revision + 1, grants: result,
      };
      await this.#persist(next);
      this.#state = next;
      return next.revision;
    });
  }

  async setEnabled(identity: ClientIdentity, input: {
    revision: number; enabled: boolean; confirmation: string;
  }): Promise<number> {
    this.#requireOwner(identity);
    return this.#serialize(async () => {
      this.#checkRevision(input.revision);
      if (typeof input.enabled !== "boolean" ||
        input.confirmation !== (input.enabled ? "ENFORCE DEVICE GRANTS" : "RESTORE LEGACY ACCESS")) {
        throw new AuthorityError("invalid_arguments", "exact owner confirmation required to change enforcement");
      }
      const next: AuthorityState = {
        ...this.#state, enabled: input.enabled, revision: this.#state.revision + 1,
      };
      await this.#persist(next);
      this.#state = next;
      return next.revision;
    });
  }

  async revokeGrants(deviceId: string): Promise<void> {
    await this.#serialize(async () => {
      const grants = this.#state.grants.filter(g => g.deviceId !== deviceId);
      if (grants.length === this.#state.grants.length) return;
      const next: AuthorityState = { ...this.#state, revision: this.#state.revision + 1, grants };
      await this.#persist(next);
      this.#state = next;
    });
  }

  evaluate(identity: ClientIdentity, deviceId: string, pairedAt: string, invocation: InvocationEnvelope):
    { allowed: true } | { allowed: false; reason: string } {
    this.observeClient(identity);
    if (!this.#state.enabled) return { allowed: true }; // Legacy path until owner explicitly activates.
    const grant = this.#state.grants.find(g => g.deviceId === deviceId && g.pairedAt === pairedAt
      && g.clientId === identity.clientId && g.principalId === identity.principalId
      && identity.accountId === this.#owner.accountId);
    if (!grant || grant.level === "blocked") return { allowed: false, reason: "owner device grant missing or blocked" };
    const allowed = grant.level === "operate" ? OPERATE : OBSERVE;
    const capability = invocation.capability;
    if (capability === "batch.execute") {
      const operations = invocation.arguments?.operations;
      if (!Array.isArray(operations) || operations.length === 0 || operations.length > 128)
        return { allowed: false, reason: "batch requires bounded explicit authorized operations" };
      for (const raw of operations) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          return { allowed: false, reason: "invalid batch child" };
        const child = (raw as Record<string, unknown>).capability;
        if (typeof child !== "string" || child === "batch.execute" || !allowed.has(child))
          return { allowed: false, reason: "batch child capability not granted by device owner" };
      }
      return { allowed: true };
    }
    return allowed.has(capability)
      ? { allowed: true }
      : { allowed: false, reason: "capability not granted by device owner" };
  }

  #requireOwner(identity: ClientIdentity): void {
    if (!this.isOwner(identity))
      throw new AuthorityError("permission_denied", "only the explicitly configured owner portal identity can manage device access");
  }
  #checkRevision(revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new AuthorityError("invalid_arguments", "a valid authority revision is required");
    if (revision !== this.#state.revision)
      throw new AuthorityError("conflict", "owner authority changed; refresh before editing");
  }
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.#queue.then(fn);
    this.#queue = task.then(() => undefined, () => undefined);
    return task;
  }
  async #persist(next: AuthorityState): Promise<void> {
    if (!this.#stateFile) return;
    await mkdir(path.dirname(this.#stateFile), { recursive: true, mode: 0o700 });
    const tmp = this.#stateFile + ".tmp-" + process.pid;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, this.#stateFile);
  }
}
