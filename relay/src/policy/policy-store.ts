import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  hasNonOwnerPrincipalPrefix,
  isAuthorizedOwnerIdentity,
  type ClientIdentity,
} from "../auth/static-auth.ts";
import type { DeviceBinding, DeviceRegistry } from "../devices/registry.ts";

export type ToolFamily =
  | "device"
  | "files"
  | "process"
  | "browser"
  | "desktop"
  | "batch";

export const ALL_TOOL_FAMILIES: readonly ToolFamily[] = [
  "batch",
  "browser",
  "desktop",
  "device",
  "files",
  "process",
];

export const CANONICAL_OPERATIONS_BY_FAMILY: Record<ToolFamily, string[]> = {
  device: [
    "device.status",
    "device.capabilities",
    "job.create",
    "job.get",
    "job.list",
    "job.checkpoint",
    "job.acquire_lease",
    "job.release_lease",
    "audit.read",
  ],
  files: [
    "filesystem.read",
    "filesystem.read_many",
    "filesystem.list",
    "filesystem.info",
    "filesystem.write",
    "filesystem.append",
    "filesystem.mkdir",
    "filesystem.move",
    "filesystem.patch",
    "search.start",
    "search.read",
    "search.stop",
    "search.list",
  ],
  process: [
    "process.run",
    "process.read",
    "process.input",
    "process.list_sessions",
    "process.list_system",
    "process.terminate",
  ],
  browser: [
    "browser.status",
    "browser.pages",
    "browser.create_tab",
    "browser.snapshot",
    "browser.navigate",
    "browser.close",
    "browser.act",
    "browser.wait",
    "browser.upload",
    "browser.downloads",
    "browser.diagnostics",
    "browser.checkpoint",
  ],
  desktop: [
    "desktop.snapshot",
    "desktop.act",
    "desktop.private_clipboard_get",
    "desktop.private_clipboard_set",
    "desktop.foreground_lease_acquire",
    "desktop.foreground_lease_get",
    "desktop.foreground_lease_release",
    "desktop.physical_pointer_move",
  ],
  batch: ["batch.execute"],
};

export const ALL_CANONICAL_OPERATIONS: readonly string[] = Object.values(
  CANONICAL_OPERATIONS_BY_FAMILY,
).flat();

const CANONICAL_OPERATION_SET = new Set<string>(ALL_CANONICAL_OPERATIONS);

export function isCanonicalCapability(capability: string): boolean {
  return CANONICAL_OPERATION_SET.has(capability);
}

export function assertCanonicalCapabilities(
  capabilities: readonly string[],
  fieldName = "capabilities",
): void {
  for (const capability of capabilities) {
    if (!CANONICAL_OPERATION_SET.has(capability)) {
      throw new Error(
        `unknown or unsupported canonical capability '${capability}' in ${fieldName}`,
      );
    }
  }
}

export type PrincipalRole = "owner" | "operator";

export type PermissionProfileId =
  | "universal"
  | "standard"
  | "read_only"
  | "files_and_process"
  | "lockdown"
  | "custom";

export type PrincipalPermissionSet = {
  principal_id: string;
  role: PrincipalRole;
  profile_id: string;
  universal_permissions: boolean;
  allowed_families: ToolFamily[];
  denied_families: ToolFamily[];
  allowed_capabilities: string[];
  denied_capabilities: string[];
  allowed_roots: string[];
  allow_destructive: boolean;
};

export type SynchronizedDevicePolicy = {
  device_id: string;
  owner_account_id: string;
  owner_principal_id: string;
  revision: number;
  updated_at_ms: number;
  updated_by: string;
  reason: string;
  emergency_lockdown: boolean;
  owner_policy: PrincipalPermissionSet;
  operator_policies: Record<string, PrincipalPermissionSet>;
};

export type DeviceSyncStatus = "applied" | "pending" | "failed";

export type DevicePolicyRecord = {
  policy: SynchronizedDevicePolicy;
  desiredRevision: number;
  appliedRevision: number | null;
  lastAckAtMs: number | null;
  lastAckError: string | null;
  status: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
};

export type PolicyAuditEvent = {
  id: string;
  timestampMs: number;
  timestampIso: string;
  accountId: string;
  actorPrincipalId: string;
  deviceId: string | null;
  action: string;
  reason: string;
  revision: number | null;
  deliveryStatus:
    | "pending_device_ack"
    | "confirmed_by_device"
    | "device_offline"
    | "delivery_failed"
    | "not_applicable";
  details: Record<string, unknown>;
};

export type PolicySnapshot = {
  snapshotId: string;
  deviceId: string;
  accountId: string;
  revision: number;
  createdAtMs: number;
  createdBy: string;
  reason: string;
  policy: SynchronizedDevicePolicy;
};

export type IdentityUsageRecord = {
  accountId: string;
  principalId: string;
  clientId: string;
  role: PrincipalRole | "unregistered";
  deviceId: string;
  capabilitiesUsed: string[];
  familiesUsed: ToolFamily[];
  authorizedCount: number;
  deniedCount: number;
  lastCapability: string;
  lastStatus: "allowed" | "denied";
  lastUsedAtMs: number;
};

export type OperatorIdentityMetadata = {
  accountId: string;
  principalId: string;
  displayName: string;
  updatedAtMs: number;
};

export type PolicyMutationInput = {
  profileId?: PermissionProfileId;
  universalPermissions?: boolean;
  allowedFamilies?: ToolFamily[];
  deniedFamilies?: ToolFamily[];
  grantFamilies?: ToolFamily[];
  revokeFamilies?: ToolFamily[];
  allowedCapabilities?: string[];
  deniedCapabilities?: string[];
  grantCapabilities?: string[];
  revokeCapabilities?: string[];
  allowedRoots?: string[];
  allowDestructive?: boolean;
  emergencyLockdown?: boolean;
  reason?: string;
};

type PersistedPolicyState = {
  version: 1;
  records: DevicePolicyRecord[];
  snapshots: PolicySnapshot[];
  auditHistory: PolicyAuditEvent[];
  identityUsage: IdentityUsageRecord[];
  operators: OperatorIdentityMetadata[];
};

export function toolFamilyForCapability(capability: string): ToolFamily | null {
  const namespace = capability.split(".")[0] ?? capability;
  switch (namespace) {
    case "device":
    case "job":
    case "audit":
      return "device";
    case "filesystem":
    case "search":
    case "files":
      return "files";
    case "process":
      return "process";
    case "browser":
      return "browser";
    case "desktop":
      return "desktop";
    case "batch":
      return "batch";
    default:
      return null;
  }
}

export function createUniversalOwnerPermissionSet(
  principalId: string,
): PrincipalPermissionSet {
  return {
    principal_id: principalId,
    role: "owner",
    profile_id: "universal",
    universal_permissions: true,
    allowed_families: [...ALL_TOOL_FAMILIES],
    denied_families: [],
    allowed_capabilities: [],
    denied_capabilities: [],
    allowed_roots: [],
    allow_destructive: true,
  };
}

export function createProfilePermissionSet(
  principalId: string,
  role: PrincipalRole,
  profileId: PermissionProfileId,
): PrincipalPermissionSet {
  switch (profileId) {
    case "universal":
      return {
        principal_id: principalId,
        role,
        profile_id: "universal",
        universal_permissions: true,
        allowed_families: [...ALL_TOOL_FAMILIES],
        denied_families: [],
        allowed_capabilities: [],
        denied_capabilities: [],
        allowed_roots: [],
        allow_destructive: true,
      };
    case "standard":
      return {
        principal_id: principalId,
        role,
        profile_id: "standard",
        universal_permissions: false,
        allowed_families: ["batch", "browser", "device", "files", "process"],
        denied_families: ["desktop"],
        allowed_capabilities: [],
        denied_capabilities: ["process.terminate"],
        allowed_roots: [],
        allow_destructive: false,
      };
    case "files_and_process":
      return {
        principal_id: principalId,
        role,
        profile_id: "files_and_process",
        universal_permissions: false,
        allowed_families: ["device", "files", "process"],
        denied_families: ["batch", "browser", "desktop"],
        allowed_capabilities: [],
        denied_capabilities: [],
        allowed_roots: [],
        allow_destructive: false,
      };
    case "read_only":
      return {
        principal_id: principalId,
        role,
        profile_id: "read_only",
        universal_permissions: false,
        allowed_families: [],
        denied_families: ["batch", "process"],
        allowed_capabilities: [
          "device.status",
          "device.capabilities",
          "job.get",
          "job.list",
          "audit.read",
          "filesystem.read",
          "filesystem.read_many",
          "filesystem.list",
          "filesystem.info",
          "search.start",
          "search.read",
          "search.stop",
          "search.list",
          "browser.status",
          "browser.pages",
          "browser.snapshot",
          "browser.wait",
          "browser.downloads",
          "browser.diagnostics",
          "browser.checkpoint",
          "desktop.snapshot",
          "desktop.private_clipboard_get",
          "desktop.foreground_lease_get",
        ],
        denied_capabilities: [
          "job.create",
          "job.checkpoint",
          "job.acquire_lease",
          "job.release_lease",
          "filesystem.write",
          "filesystem.append",
          "filesystem.mkdir",
          "filesystem.move",
          "filesystem.patch",
          "browser.create_tab",
          "browser.navigate",
          "browser.close",
          "browser.act",
          "browser.upload",
          "desktop.act",
          "desktop.private_clipboard_set",
          "desktop.foreground_lease_acquire",
          "desktop.foreground_lease_release",
          "desktop.physical_pointer_move",
        ],
        allowed_roots: [],
        allow_destructive: false,
      };
    case "lockdown":
      return {
        principal_id: principalId,
        role,
        profile_id: "lockdown",
        universal_permissions: false,
        allowed_families: [],
        denied_families: [...ALL_TOOL_FAMILIES],
        allowed_capabilities: [],
        denied_capabilities: [],
        allowed_roots: [],
        allow_destructive: false,
      };
    case "custom":
      return {
        principal_id: principalId,
        role,
        profile_id: "custom",
        universal_permissions: false,
        allowed_families: ["device"],
        denied_families: [],
        allowed_capabilities: [],
        denied_capabilities: [],
        allowed_roots: [],
        allow_destructive: false,
      };
  }
}

export function evaluatePermissionSet(
  set: PrincipalPermissionSet,
  capability: string,
): {
  allowed: boolean;
  denialKind?: "explicit_deny" | "family_revoked" | "operation_not_granted";
} {
  if (set.denied_capabilities.includes(capability)) {
    return { allowed: false, denialKind: "explicit_deny" };
  }
  const family = toolFamilyForCapability(capability);
  if (family && set.denied_families.includes(family)) {
    return { allowed: false, denialKind: "explicit_deny" };
  }
  if (set.allowed_capabilities.includes(capability)) {
    return { allowed: true };
  }
  if (family && set.allowed_families.includes(family)) {
    return { allowed: true };
  }
  if (set.universal_permissions) {
    return { allowed: true };
  }
  if (set.role === "owner" && family && !set.allowed_families.includes(family)) {
    return { allowed: false, denialKind: "family_revoked" };
  }
  return { allowed: false, denialKind: "operation_not_granted" };
}

export const DEFAULT_MAX_AUDIT_HISTORY = 500;

export class PolicyStore {
  readonly #stateFile: string | null;
  readonly #registry: DeviceRegistry;
  readonly #maxAuditHistory: number;
  readonly #records = new Map<string, DevicePolicyRecord>();
  readonly #snapshots: PolicySnapshot[] = [];
  readonly #auditHistory: PolicyAuditEvent[] = [];
  readonly #identityUsage = new Map<string, IdentityUsageRecord>();
  readonly #operators = new Map<string, OperatorIdentityMetadata>();
  readonly #changeListeners = new Map<string, Set<() => void>>();
  #pushPolicyCallback:
    | ((deviceId: string, policy: SynchronizedDevicePolicy) => Promise<boolean>)
    | null = null;
  #isOnlineCallback: ((deviceId: string) => boolean) | null = null;

  private constructor(options: {
    registry: DeviceRegistry;
    stateFile?: string;
    maxAuditHistory?: number;
  }) {
    this.#registry = options.registry;
    this.#stateFile = options.stateFile
      ? `${options.stateFile}.policy.json`
      : null;
    const maxAudit = options.maxAuditHistory ?? DEFAULT_MAX_AUDIT_HISTORY;
    if (!Number.isSafeInteger(maxAudit) || maxAudit < 1) {
      throw new Error("maxAuditHistory must be a positive integer");
    }
    this.#maxAuditHistory = maxAudit;
  }

  static async open(options: {
    registry: DeviceRegistry;
    stateFile?: string;
    maxAuditHistory?: number;
  }): Promise<PolicyStore> {
    const store = new PolicyStore(options);
    await store.#load();
    return store;
  }

  subscribe(accountId: string, listener: () => void): () => void {
    let listeners = this.#changeListeners.get(accountId);
    if (!listeners) {
      listeners = new Set();
      this.#changeListeners.set(accountId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.#changeListeners.get(accountId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.#changeListeners.delete(accountId);
      }
    };
  }

  notifyChange(accountId: string): void {
    const listeners = this.#changeListeners.get(accountId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Listener failures must never disrupt policy persistence or delivery
      }
    }
  }

  setSyncHooks(hooks: {
    pushPolicy: (
      deviceId: string,
      policy: SynchronizedDevicePolicy,
    ) => Promise<boolean>;
    isOnline: (deviceId: string) => boolean;
  }): void {
    this.#pushPolicyCallback = hooks.pushPolicy;
    this.#isOnlineCallback = hooks.isOnline;
  }

  async ensureDevicePolicy(
    binding: DeviceBinding,
    owner?: string | ClientIdentity,
  ): Promise<DevicePolicyRecord> {
    const existing = this.#records.get(binding.deviceId);
    if (existing && existing.policy.owner_account_id === binding.accountId) {
      return existing;
    }

    let resolvedOwnerPrincipal: string;
    const canonicalOwner = `human:${binding.accountId}`;
    if (owner === undefined) {
      resolvedOwnerPrincipal = canonicalOwner;
    } else if (typeof owner === "string") {
      const candidate = owner.trim();
      if (
        !candidate ||
        hasNonOwnerPrincipalPrefix(candidate) ||
        candidate !== canonicalOwner
      ) {
        throw new Error(
          `cannot assign non-owner principal '${owner}' as device owner`,
        );
      }
      resolvedOwnerPrincipal = candidate;
    } else {
      if (
        owner.accountId !== binding.accountId ||
        !isAuthorizedOwnerIdentity(owner)
      ) {
        throw new Error(
          `identity '${owner.principalId}' is not authorized to own devices for account '${binding.accountId}'`,
        );
      }
      resolvedOwnerPrincipal = owner.principalId.trim();
    }
    const now = Date.now();
    const policy: SynchronizedDevicePolicy = {
      device_id: binding.deviceId,
      owner_account_id: binding.accountId,
      owner_principal_id: resolvedOwnerPrincipal,
      revision: 1,
      updated_at_ms: now,
      updated_by: resolvedOwnerPrincipal,
      reason: "Universal default permissions assigned to owner-paired device",
      emergency_lockdown: false,
      owner_policy: createUniversalOwnerPermissionSet(resolvedOwnerPrincipal),
      operator_policies: {},
    };

    const record: DevicePolicyRecord = {
      policy,
      desiredRevision: 1,
      appliedRevision: null,
      lastAckAtMs: null,
      lastAckError: null,
      status: null,
      capabilities: null,
    };

    this.#records.set(binding.deviceId, record);
    this.#saveSnapshot(record, resolvedOwnerPrincipal, policy.reason);
    this.#appendAudit({
      accountId: binding.accountId,
      actorPrincipalId: resolvedOwnerPrincipal,
      deviceId: binding.deviceId,
      action: "device_paired_universal",
      reason: policy.reason,
      revision: 1,
      deliveryStatus: this.#isDeviceOnline(binding.deviceId)
        ? "pending_device_ack"
        : "device_offline",
      details: {
        profileId: "universal",
        allowedFamilies: policy.owner_policy.allowed_families,
      },
    });
    await this.#persist();
    this.notifyChange(binding.accountId);
    return record;
  }

  getRecord(deviceId: string): DevicePolicyRecord | null {
    const existing = this.#records.get(deviceId);
    if (existing) return existing;
    const binding = this.#registry.getDevice(deviceId);
    if (!binding || binding.revokedAt !== null) return null;
    const ownerPrincipal = `human:${binding.accountId}`;
    const policy: SynchronizedDevicePolicy = {
      device_id: binding.deviceId,
      owner_account_id: binding.accountId,
      owner_principal_id: ownerPrincipal,
      revision: 1,
      updated_at_ms: Date.now(),
      updated_by: ownerPrincipal,
      reason: "Universal default permissions assigned to owner-paired device",
      emergency_lockdown: false,
      owner_policy: createUniversalOwnerPermissionSet(ownerPrincipal),
      operator_policies: {},
    };
    const created: DevicePolicyRecord = {
      policy,
      desiredRevision: 1,
      appliedRevision: null,
      lastAckAtMs: null,
      lastAckError: null,
      status: null,
      capabilities: null,
    };
    this.#records.set(deviceId, created);
    this.#saveSnapshot(created, ownerPrincipal, policy.reason);
    return created;
  }

  async handleDeviceHello(input: {
    deviceId: string;
    accountId: string;
    appliedPolicyRevision: number | null;
    status?: Record<string, unknown> | null;
    capabilities?: Record<string, unknown> | null;
  }): Promise<SynchronizedDevicePolicy | null> {
    const binding = this.#registry.getDevice(input.deviceId);
    if (!binding || binding.accountId !== input.accountId) return null;
    const record = await this.ensureDevicePolicy(binding);
    if (input.status) {
      record.status = input.status;
    }
    if (input.capabilities) {
      record.capabilities = input.capabilities;
    }

    const reportedRevision =
      typeof input.appliedPolicyRevision === "number" &&
      Number.isFinite(input.appliedPolicyRevision) &&
      input.appliedPolicyRevision >= 1
        ? input.appliedPolicyRevision
        : null;

    if (reportedRevision !== null && reportedRevision > record.desiredRevision) {
      record.appliedRevision = reportedRevision;
      record.lastAckAtMs = Date.now();
      record.lastAckError = `Device reported applied revision ${reportedRevision} ahead of relay desired revision ${record.desiredRevision}`;
      this.#appendAudit({
        accountId: input.accountId,
        actorPrincipalId: `device:${input.deviceId}`,
        deviceId: input.deviceId,
        action: "policy_revision_ahead",
        reason: record.lastAckError,
        revision: reportedRevision,
        deliveryStatus: "not_applicable",
        details: {
          desiredRevision: record.desiredRevision,
          reportedRevision,
        },
      });
      await this.#persist();
      this.notifyChange(input.accountId);
      return null;
    }

    if (reportedRevision !== null && reportedRevision === record.desiredRevision) {
      record.appliedRevision = reportedRevision;
      record.lastAckAtMs = Date.now();
      record.lastAckError = null;
      this.#markAuditDelivery(
        input.deviceId,
        reportedRevision,
        "confirmed_by_device",
      );
    } else {
      record.appliedRevision = reportedRevision;
      record.lastAckError = null;
    }

    await this.#persist();
    this.notifyChange(input.accountId);
    return structuredClone(record.policy);
  }

  async handlePolicyAck(input: {
    deviceId: string;
    accountId: string;
    revision: number;
    currentRevision?: number | null;
    applied: boolean;
    appliedAtMs?: number;
    status?: Record<string, unknown> | null;
    capabilities?: Record<string, unknown> | null;
    error?: string | null;
  }): Promise<void> {
    const record = this.getRecord(input.deviceId);
    if (!record || record.policy.owner_account_id !== input.accountId) {
      return;
    }
    if (input.status) {
      record.status = input.status;
    }
    if (input.capabilities) {
      record.capabilities = input.capabilities;
    }
    if (input.applied) {
      if (input.revision > record.desiredRevision) {
        if (
          record.appliedRevision === null ||
          input.revision > record.appliedRevision
        ) {
          record.appliedRevision = input.revision;
        }
        record.lastAckError = `Device acknowledged unexpected future revision ${input.revision} ahead of desired revision ${record.desiredRevision}`;
      } else {
        if (
          record.appliedRevision === null ||
          input.revision >= record.appliedRevision
        ) {
          record.appliedRevision = input.revision;
        }
        if (input.revision === record.desiredRevision) {
          record.lastAckAtMs = input.appliedAtMs ?? Date.now();
          record.lastAckError = null;
        }
        this.#markAuditDelivery(
          input.deviceId,
          input.revision,
          "confirmed_by_device",
        );
      }
    } else {
      if (
        typeof input.currentRevision === "number" &&
        Number.isFinite(input.currentRevision)
      ) {
        record.appliedRevision =
          input.currentRevision >= 1 ? input.currentRevision : null;
      }
      if (
        input.revision >= record.desiredRevision ||
        (record.appliedRevision !== record.desiredRevision &&
          !record.lastAckError)
      ) {
        record.lastAckError = input.error ?? "Device rejected policy update";
      }
      this.#markAuditDelivery(
        input.deviceId,
        input.revision,
        "delivery_failed",
      );
    }
    await this.#persist();
    this.notifyChange(input.accountId);
  }

  async handleDeviceTelemetry(input: {
    deviceId: string;
    accountId: string;
    status?: Record<string, unknown> | null;
    capabilities?: Record<string, unknown> | null;
  }): Promise<void> {
    const record = this.getRecord(input.deviceId);
    if (!record || record.policy.owner_account_id !== input.accountId) {
      return;
    }
    let changed = false;
    if (input.status) {
      record.status = input.status;
      changed = true;
    }
    if (input.capabilities) {
      record.capabilities = input.capabilities;
      changed = true;
    }
    if (!changed) return;
    await this.#persist();
    this.notifyChange(input.accountId);
  }

  async updateDevicePolicy(input: {
    accountId: string;
    actorPrincipalId: string;
    deviceId: string;
    mutation: PolicyMutationInput;
    actionName?: string;
  }): Promise<DevicePolicyRecord> {
    const binding = this.#registry.getDevice(input.deviceId);
    if (
      !binding ||
      binding.accountId !== input.accountId ||
      binding.revokedAt !== null
    ) {
      throw new Error("device is not authorized for this account");
    }
    const record = await this.ensureDevicePolicy(binding);
    const nextRevision =
      Math.max(record.desiredRevision, record.appliedRevision ?? 0) + 1;
    const now = Date.now();
    const nextOwnerPolicy = applyMutationToPermissionSet(
      record.policy.owner_policy,
      input.mutation,
    );
    const reason =
      input.mutation.reason?.trim() ||
      `Updated permissions for ${input.deviceId} (revision ${nextRevision})`;

    const nextPolicy: SynchronizedDevicePolicy = {
      ...structuredClone(record.policy),
      revision: nextRevision,
      updated_at_ms: now,
      updated_by: input.actorPrincipalId,
      reason,
      emergency_lockdown:
        input.mutation.emergencyLockdown ?? record.policy.emergency_lockdown,
      owner_policy: nextOwnerPolicy,
    };

    record.policy = nextPolicy;
    record.desiredRevision = nextRevision;
    record.lastAckError = null;

    this.#saveSnapshot(record, input.actorPrincipalId, reason);
    const isOnline = this.#isDeviceOnline(input.deviceId);
    this.#appendAudit({
      accountId: input.accountId,
      actorPrincipalId: input.actorPrincipalId,
      deviceId: input.deviceId,
      action: input.actionName ?? "policy_updated",
      reason,
      revision: nextRevision,
      deliveryStatus: isOnline ? "pending_device_ack" : "device_offline",
      details: {
        profileId: nextOwnerPolicy.profile_id,
        universalPermissions: nextOwnerPolicy.universal_permissions,
        allowedFamilies: nextOwnerPolicy.allowed_families,
        deniedFamilies: nextOwnerPolicy.denied_families,
        allowedCapabilities: nextOwnerPolicy.allowed_capabilities,
        deniedCapabilities: nextOwnerPolicy.denied_capabilities,
        emergencyLockdown: nextPolicy.emergency_lockdown,
      },
    });

    await this.#persist();
    this.notifyChange(input.accountId);
    await this.#pushToDeviceIfOnline(input.deviceId, nextPolicy);
    return record;
  }

  async applyGlobalPolicy(input: {
    accountId: string;
    actorPrincipalId: string;
    deviceIds?: string[];
    mutation: PolicyMutationInput;
    actionName?: string;
  }): Promise<DevicePolicyRecord[]> {
    const paired = this.#registry
      .listDevices(input.accountId)
      .filter((d) => d.revokedAt === null);
    const targetIds =
      input.deviceIds && input.deviceIds.length > 0
        ? new Set(input.deviceIds)
        : new Set(paired.map((d) => d.deviceId));

    const updated: DevicePolicyRecord[] = [];
    for (const binding of paired) {
      if (!targetIds.has(binding.deviceId)) continue;
      const record = await this.updateDevicePolicy({
        accountId: input.accountId,
        actorPrincipalId: input.actorPrincipalId,
        deviceId: binding.deviceId,
        mutation: input.mutation,
        actionName: input.actionName ?? "global_policy_applied",
      });
      updated.push(record);
    }
    return updated;
  }

  async upsertOperatorPolicy(input: {
    accountId: string;
    actorPrincipalId: string;
    operatorPrincipalId: string;
    displayName?: string;
    deviceIds?: string[];
    mutation: PolicyMutationInput;
  }): Promise<DevicePolicyRecord[]> {
    const operatorId = input.operatorPrincipalId.trim();
    if (!operatorId) {
      throw new Error("principalId is required for operator policy");
    }
    const canonicalOwner = `human:${input.accountId}`;
    const paired = this.#registry
      .listDevices(input.accountId)
      .filter((d) => d.revokedAt === null);

    if (
      operatorId === canonicalOwner ||
      operatorId === input.actorPrincipalId ||
      paired.some((binding) => {
        const rec = this.#records.get(binding.deviceId);
        return (
          rec !== undefined &&
          (rec.policy.owner_principal_id === operatorId ||
            rec.policy.owner_policy.principal_id === operatorId)
        );
      })
    ) {
      throw new Error(
        `operator principalId '${operatorId}' cannot collide with an owner identity`,
      );
    }

    this.#operators.set(`${input.accountId}::${operatorId}`, {
      accountId: input.accountId,
      principalId: operatorId,
      displayName: input.displayName?.trim() || operatorId,
      updatedAtMs: Date.now(),
    });

    const targetIds =
      input.deviceIds && input.deviceIds.length > 0
        ? new Set(input.deviceIds)
        : new Set(paired.map((d) => d.deviceId));

    const updated: DevicePolicyRecord[] = [];
    for (const binding of paired) {
      if (!targetIds.has(binding.deviceId)) continue;
      const record = await this.ensureDevicePolicy(binding);
      const currentOp =
        record.policy.operator_policies[operatorId] ??
        createProfilePermissionSet(
          operatorId,
          "operator",
          input.mutation.profileId ?? "custom",
        );
      const nextOp = applyMutationToPermissionSet(currentOp, {
        ...input.mutation,
        universalPermissions: input.mutation.universalPermissions ?? false,
      });
      nextOp.role = "operator";
      nextOp.principal_id = operatorId;

      const nextRevision =
        Math.max(record.desiredRevision, record.appliedRevision ?? 0) + 1;
      const reason =
        input.mutation.reason?.trim() ||
        `Configured operator ${operatorId} on ${binding.deviceId}`;
      const nextPolicy: SynchronizedDevicePolicy = {
        ...structuredClone(record.policy),
        revision: nextRevision,
        updated_at_ms: Date.now(),
        updated_by: input.actorPrincipalId,
        reason,
        operator_policies: {
          ...structuredClone(record.policy.operator_policies),
          [operatorId]: nextOp,
        },
      };

      record.policy = nextPolicy;
      record.desiredRevision = nextRevision;
      record.lastAckError = null;
      this.#saveSnapshot(record, input.actorPrincipalId, reason);
      this.#appendAudit({
        accountId: input.accountId,
        actorPrincipalId: input.actorPrincipalId,
        deviceId: binding.deviceId,
        action: "operator_updated",
        reason,
        revision: nextRevision,
        deliveryStatus: this.#isDeviceOnline(binding.deviceId)
          ? "pending_device_ack"
          : "device_offline",
        details: {
          operatorPrincipalId: operatorId,
          allowedFamilies: nextOp.allowed_families,
          deniedFamilies: nextOp.denied_families,
          allowedCapabilities: nextOp.allowed_capabilities,
          deniedCapabilities: nextOp.denied_capabilities,
        },
      });
      await this.#pushToDeviceIfOnline(binding.deviceId, nextPolicy);
      updated.push(record);
    }

    await this.#persist();
    this.notifyChange(input.accountId);
    return updated;
  }

  async removeOperatorPolicy(input: {
    accountId: string;
    actorPrincipalId: string;
    operatorPrincipalId: string;
    reason?: string;
  }): Promise<void> {
    const operatorId = input.operatorPrincipalId.trim();
    this.#operators.delete(`${input.accountId}::${operatorId}`);
    const paired = this.#registry
      .listDevices(input.accountId)
      .filter((d) => d.revokedAt === null);

    let modifiedAnyDevice = false;
    for (const binding of paired) {
      const record = await this.ensureDevicePolicy(binding);
      if (!(operatorId in record.policy.operator_policies)) continue;
      modifiedAnyDevice = true;
      const nextOperators = structuredClone(record.policy.operator_policies);
      delete nextOperators[operatorId];
      const nextRevision =
        Math.max(record.desiredRevision, record.appliedRevision ?? 0) + 1;
      const reason =
        input.reason?.trim() ||
        `Removed operator ${operatorId} from ${binding.deviceId}`;
      const nextPolicy: SynchronizedDevicePolicy = {
        ...structuredClone(record.policy),
        revision: nextRevision,
        updated_at_ms: Date.now(),
        updated_by: input.actorPrincipalId,
        reason,
        operator_policies: nextOperators,
      };
      record.policy = nextPolicy;
      record.desiredRevision = nextRevision;
      record.lastAckError = null;
      this.#saveSnapshot(record, input.actorPrincipalId, reason);
      this.#appendAudit({
        accountId: input.accountId,
        actorPrincipalId: input.actorPrincipalId,
        deviceId: binding.deviceId,
        action: "operator_removed",
        reason,
        revision: nextRevision,
        deliveryStatus: this.#isDeviceOnline(binding.deviceId)
          ? "pending_device_ack"
          : "device_offline",
        details: { operatorPrincipalId: operatorId },
      });
      await this.#pushToDeviceIfOnline(binding.deviceId, nextPolicy);
    }
    if (!modifiedAnyDevice) {
      this.#appendAudit({
        accountId: input.accountId,
        actorPrincipalId: input.actorPrincipalId,
        deviceId: null,
        action: "operator_removed",
        reason: input.reason?.trim() || `Removed operator ${operatorId}`,
        revision: null,
        deliveryStatus: "not_applicable",
        details: { operatorPrincipalId: operatorId },
      });
    }
    await this.#persist();
    this.notifyChange(input.accountId);
  }

  async rollbackDevicePolicy(input: {
    accountId: string;
    actorPrincipalId: string;
    deviceId: string;
    targetRevision: number;
    reason?: string;
  }): Promise<DevicePolicyRecord> {
    const binding = this.#registry.getDevice(input.deviceId);
    if (
      !binding ||
      binding.accountId !== input.accountId ||
      binding.revokedAt !== null
    ) {
      throw new Error("device is not authorized for this account");
    }
    const snapshot = this.#snapshots.find(
      (s) =>
        s.accountId === input.accountId &&
        s.deviceId === input.deviceId &&
        s.revision === input.targetRevision,
    );
    if (!snapshot) {
      throw new Error(
        `no recoverable snapshot found for device ${input.deviceId} at revision ${input.targetRevision}`,
      );
    }

    const record = await this.ensureDevicePolicy(binding);
    const nextRevision =
      Math.max(record.desiredRevision, record.appliedRevision ?? 0) + 1;
    const reason =
      input.reason?.trim() ||
      `Rolled back ${input.deviceId} to snapshot revision ${input.targetRevision}`;

    const restoredPolicy: SynchronizedDevicePolicy = {
      ...structuredClone(snapshot.policy),
      revision: nextRevision,
      updated_at_ms: Date.now(),
      updated_by: input.actorPrincipalId,
      reason,
    };

    record.policy = restoredPolicy;
    record.desiredRevision = nextRevision;
    record.lastAckError = null;

    this.#saveSnapshot(record, input.actorPrincipalId, reason);
    this.#appendAudit({
      accountId: input.accountId,
      actorPrincipalId: input.actorPrincipalId,
      deviceId: input.deviceId,
      action: "policy_rollback",
      reason,
      revision: nextRevision,
      deliveryStatus: this.#isDeviceOnline(input.deviceId)
        ? "pending_device_ack"
        : "device_offline",
      details: {
        restoredFromRevision: input.targetRevision,
        newRevision: nextRevision,
      },
    });
    await this.#persist();
    this.notifyChange(input.accountId);
    await this.#pushToDeviceIfOnline(input.deviceId, restoredPolicy);
    return record;
  }

  evaluateAndRecordInvocation(input: {
    identity: ClientIdentity;
    deviceId: string;
    capability: string;
  }): {
    allowed: boolean;
    denialKind?: string;
    message?: string;
    recoveryHint?: string;
  } {
    const record = this.getRecord(input.deviceId);
    if (!record) {
      return { allowed: true };
    }

    const policy = record.policy;
    const principalId = input.identity.principalId;
    const canonicalOwner = `human:${policy.owner_account_id}`;
    const hasOperatorEntry = Object.prototype.hasOwnProperty.call(
      policy.operator_policies,
      principalId,
    );
    const operatorEntry = hasOperatorEntry
      ? policy.operator_policies[principalId]
      : undefined;

    let permissionSet: PrincipalPermissionSet | null = null;
    if (operatorEntry) {
      if (
        operatorEntry.role === "operator" &&
        operatorEntry.principal_id === principalId &&
        principalId !== policy.owner_principal_id &&
        principalId !== canonicalOwner
      ) {
        permissionSet = operatorEntry;
      }
    } else if (
      input.identity.accountId === policy.owner_account_id &&
      isAuthorizedOwnerIdentity(input.identity, policy.owner_principal_id) &&
      policy.owner_policy.role === "owner" &&
      !hasNonOwnerPrincipalPrefix(policy.owner_principal_id) &&
      (principalId === policy.owner_principal_id ||
        principalId === policy.owner_policy.principal_id ||
        principalId === canonicalOwner)
    ) {
      permissionSet = policy.owner_policy;
    }

    const role: PrincipalRole | "unregistered" = permissionSet
      ? permissionSet.role
      : "unregistered";

    if (policy.emergency_lockdown) {
      this.#recordUsage(
        input.identity,
        role,
        input.deviceId,
        input.capability,
        "denied",
      );
      this.#appendAudit({
        accountId: input.identity.accountId,
        actorPrincipalId: principalId,
        deviceId: input.deviceId,
        action: "authorization_denied",
        reason: `Capability '${input.capability}' blocked by Emergency Access Revocation`,
        revision: record.appliedRevision ?? record.desiredRevision,
        deliveryStatus: "not_applicable",
        details: {
          capability: input.capability,
          denial_kind: "emergency_lockdown",
        },
      });
      this.notifyChange(input.identity.accountId);
      return {
        allowed: false,
        denialKind: "emergency_lockdown",
        message: `Emergency access lockdown is active on device '${input.deviceId}'`,
        recoveryHint:
          "Lift the emergency access lockdown in the Tetherplane Control Portal.",
      };
    }

    if (!permissionSet) {
      this.#recordUsage(
        input.identity,
        "unregistered",
        input.deviceId,
        input.capability,
        "denied",
      );
      this.#appendAudit({
        accountId: input.identity.accountId,
        actorPrincipalId: principalId,
        deviceId: input.deviceId,
        action: "authorization_denied",
        reason: `Unpaired or unauthorized identity '${principalId}' denied '${input.capability}'`,
        revision: record.appliedRevision ?? record.desiredRevision,
        deliveryStatus: "not_applicable",
        details: {
          capability: input.capability,
          denial_kind: "unpaired_or_unauthorized_identity",
        },
      });
      this.notifyChange(input.identity.accountId);
      return {
        allowed: false,
        denialKind: "unpaired_or_unauthorized_identity",
        message: `Identity '${principalId}' is not authorized on device '${input.deviceId}'`,
        recoveryHint:
          "Authorize this operator identity in the Tetherplane Control Portal.",
      };
    }

    const evaluation = evaluatePermissionSet(permissionSet, input.capability);
    if (!evaluation.allowed) {
      this.#recordUsage(
        input.identity,
        permissionSet.role,
        input.deviceId,
        input.capability,
        "denied",
      );
      const family = toolFamilyForCapability(input.capability);
      this.#appendAudit({
        accountId: input.identity.accountId,
        actorPrincipalId: principalId,
        deviceId: input.deviceId,
        action: "authorization_denied",
        reason: `Principal '${principalId}' denied '${input.capability}' (${evaluation.denialKind})`,
        revision: record.appliedRevision ?? record.desiredRevision,
        deliveryStatus: "not_applicable",
        details: {
          capability: input.capability,
          tool_family: family,
          denial_kind: evaluation.denialKind,
        },
      });
      this.notifyChange(input.identity.accountId);
      return {
        allowed: false,
        denialKind: evaluation.denialKind ?? "operation_not_granted",
        message: `Capability '${input.capability}' is not granted for '${principalId}' (${evaluation.denialKind})`,
        recoveryHint: family
          ? `Grant the '${family}' tool family or '${input.capability}' in the Tetherplane Control Portal.`
          : `Grant '${input.capability}' in the Tetherplane Control Portal.`,
      };
    }

    this.#recordUsage(
      input.identity,
      permissionSet.role,
      input.deviceId,
      input.capability,
      "allowed",
    );
    this.notifyChange(input.identity.accountId);
    return { allowed: true };
  }

  async buildPortalOverview(
    accountId: string,
    ownerPrincipalId?: string,
  ): Promise<Record<string, unknown>> {
    const bindings = this.#registry
      .listDevices(accountId)
      .filter((d) => d.revokedAt === null);

    const devices = [];
    for (const binding of bindings) {
      const record = await this.ensureDevicePolicy(binding);
      devices.push(this.formatDeviceOverview(binding, record));
    }

    const operators = [...this.#operators.values()].filter(
      (op) => op.accountId === accountId,
    );
    const identityUsage = [...this.#identityUsage.values()]
      .filter((u) => u.accountId === accountId)
      .sort((a, b) => b.lastUsedAtMs - a.lastUsedAtMs);
    const auditHistory = this.#auditHistory
      .filter((a) => a.accountId === accountId)
      .slice(-100)
      .reverse();
    const snapshots = this.#snapshots
      .filter((s) => s.accountId === accountId)
      .reverse();

    return {
      accountId,
      ownerPrincipalId: ownerPrincipalId ?? `human:${accountId}`,
      toolFamilies: ALL_TOOL_FAMILIES,
      canonicalOperationsByFamily: CANONICAL_OPERATIONS_BY_FAMILY,
      profiles: [
        {
          id: "universal",
          name: "Universal Access (Default)",
          description:
            "Full access across all six MCP tool families (device, files, process, browser, desktop, batch), auto-approving destructive file replacements and AI-owned process termination while blocking human-origin process termination and protecting unshared human tabs/windows.",
        },
        {
          id: "standard",
          name: "Standard Automation",
          description:
            "Device, files, process, browser, and batch enabled; desktop and destructive process termination restricted.",
        },
        {
          id: "files_and_process",
          name: "Files & Process Only",
          description:
            "Filesystem, search, process, and device operations only; browser, desktop, and batch disabled.",
        },
        {
          id: "read_only",
          name: "Read & Inspect Only",
          description:
            "Non-mutating inspection across device, filesystem read/search, browser snapshot, and desktop snapshot.",
        },
        {
          id: "lockdown",
          name: "Zero Access (Revoked)",
          description: "All six MCP tool families revoked on the target device.",
        },
      ],
      devices,
      operators,
      identityUsage,
      auditHistory,
      snapshots,
    };
  }

  formatDeviceOverview(
    binding: DeviceBinding,
    record: DevicePolicyRecord,
  ): Record<string, unknown> {
    const online = this.#isDeviceOnline(binding.deviceId);
    const confirmedByDevice =
      record.appliedRevision !== null &&
      record.appliedRevision === record.desiredRevision &&
      record.lastAckError === null;
    const syncStatus: DeviceSyncStatus = record.lastAckError
      ? "failed"
      : confirmedByDevice
        ? "applied"
        : "pending";

    const rawProviders = Array.isArray(record.capabilities?.providers)
      ? (record.capabilities.providers as Array<Record<string, unknown>>)
      : [];

    const unavailableCapabilities = rawProviders
      .filter(
        (p) =>
          p.available === false ||
          (typeof p.status === "string" && p.status !== "ready"),
      )
      .map((p) => ({
        name: String(p.namespace ?? p.name ?? p.tool_family ?? "unknown"),
        toolFamily: String(p.tool_family ?? p.namespace ?? "device"),
        status:
          typeof p.status === "string"
            ? p.status
            : p.available === false
              ? "unavailable"
              : "ready",
        reason:
          typeof p.unavailable_reason === "string"
            ? p.unavailable_reason
            : "Provider reported unavailable",
      }));

    const rawToolFamilies = record.capabilities?.tool_families;
    const familySummaries = ALL_TOOL_FAMILIES.map((family) => {
      const canonicalOps = CANONICAL_OPERATIONS_BY_FAMILY[family] ?? [];
      let reportedFamily: Record<string, unknown> | undefined;
      if (Array.isArray(rawToolFamilies)) {
        reportedFamily = (
          rawToolFamilies as Array<Record<string, unknown>>
        ).find((f) => f.family === family);
      } else if (rawToolFamilies && typeof rawToolFamilies === "object") {
        const candidate = (rawToolFamilies as Record<string, unknown>)[family];
        if (candidate && typeof candidate === "object") {
          reportedFamily = candidate as Record<string, unknown>;
        }
      }

      const matchingProviders = rawProviders.filter(
        (p) => p.tool_family === family,
      );
      let providerAvailable: boolean;
      if (reportedFamily) {
        if (typeof reportedFamily.available === "boolean") {
          providerAvailable = reportedFamily.available;
        } else if (typeof reportedFamily.provider_available === "boolean") {
          providerAvailable = reportedFamily.provider_available;
        } else if (matchingProviders.length > 0) {
          providerAvailable = matchingProviders.some(
            (p) => p.available === true || p.status === "ready",
          );
        } else {
          providerAvailable = false;
        }
      } else if (matchingProviders.length > 0) {
        providerAvailable = matchingProviders.some(
          (p) => p.available === true || p.status === "ready",
        );
      } else {
        providerAvailable = online;
      }

      let availableOperations: string[];
      if (!providerAvailable) {
        availableOperations = [];
      } else if (reportedFamily && Array.isArray(reportedFamily.available_operations)) {
        availableOperations = reportedFamily.available_operations.filter(
          (op): op is string => typeof op === "string",
        );
      } else if (matchingProviders.length > 0) {
        const derivedOps: string[] = [];
        for (const provider of matchingProviders) {
          if (provider.available !== true && provider.status !== "ready") continue;
          const ns =
            typeof provider.namespace === "string"
              ? provider.namespace
              : typeof provider.name === "string"
                ? provider.name
                : "";
          if (Array.isArray(provider.available_operations)) {
            for (const op of provider.available_operations) {
              if (typeof op === "string") {
                derivedOps.push(ns ? `${ns}.${op}` : op);
              }
            }
          }
        }
        availableOperations = providerAvailable ? derivedOps : [];
      } else {
        availableOperations = providerAvailable ? canonicalOps : [];
      }

      const unavailableReason = !providerAvailable
        ? typeof reportedFamily?.unavailable_reason === "string"
          ? reportedFamily.unavailable_reason
          : (unavailableCapabilities.find((u) => u.toolFamily === family)
              ?.reason ?? null)
        : null;

      const policyGrantedOperations = canonicalOps.filter(
        (op) =>
          !record.policy.emergency_lockdown &&
          evaluatePermissionSet(record.policy.owner_policy, op).allowed,
      );

      const grantedOperations = availableOperations.filter(
        (op) =>
          !record.policy.emergency_lockdown &&
          evaluatePermissionSet(record.policy.owner_policy, op).allowed,
      );

      const deniedOperations = canonicalOps.filter(
        (op) =>
          record.policy.emergency_lockdown ||
          !evaluatePermissionSet(record.policy.owner_policy, op).allowed,
      );

      const familyGranted =
        !record.policy.emergency_lockdown &&
        !record.policy.owner_policy.denied_families.includes(family) &&
        (record.policy.owner_policy.universal_permissions ||
          record.policy.owner_policy.allowed_families.includes(family));

      return {
        family,
        granted: familyGranted,
        providerAvailable,
        unavailableReason,
        availableOperations,
        policyGrantedOperations,
        grantedOperations,
        deniedOperations,
      };
    });

    return {
      deviceId: binding.deviceId,
      accountId: binding.accountId,
      pairedAt: binding.pairedAt,
      online,
      agentHealth: online
        ? unavailableCapabilities.length > 0
          ? "degraded"
          : "healthy"
        : "offline",
      syncStatus,
      confirmedByDevice,
      desiredRevision: record.desiredRevision,
      appliedRevision: record.appliedRevision,
      lastAckAtMs: record.lastAckAtMs,
      lastAckError: record.lastAckError,
      emergencyLockdown: record.policy.emergency_lockdown,
      status: record.status,
      capabilities: record.capabilities,
      unavailableCapabilities,
      familySummaries,
      policy: record.policy,
    };
  }

  listAuditEvents(accountId: string): PolicyAuditEvent[] {
    return this.#auditHistory
      .filter((a) => a.accountId === accountId)
      .slice(-100)
      .reverse();
  }

  #isDeviceOnline(deviceId: string): boolean {
    return this.#isOnlineCallback ? this.#isOnlineCallback(deviceId) : false;
  }

  async #pushToDeviceIfOnline(
    deviceId: string,
    policy: SynchronizedDevicePolicy,
  ): Promise<void> {
    if (!this.#pushPolicyCallback) return;
    await this.#pushPolicyCallback(deviceId, policy);
  }

  #saveSnapshot(
    record: DevicePolicyRecord,
    createdBy: string,
    reason: string,
  ): void {
    const existingIndex = this.#snapshots.findIndex(
      (s) =>
        s.deviceId === record.policy.device_id &&
        s.revision === record.desiredRevision,
    );
    const snapshot: PolicySnapshot = {
      snapshotId: randomUUID(),
      deviceId: record.policy.device_id,
      accountId: record.policy.owner_account_id,
      revision: record.desiredRevision,
      createdAtMs: Date.now(),
      createdBy,
      reason,
      policy: structuredClone(record.policy),
    };
    if (existingIndex >= 0) {
      this.#snapshots[existingIndex] = snapshot;
    } else {
      this.#snapshots.push(snapshot);
    }
    const retained = retainSnapshotsForPersistence(this.#snapshots);
    if (retained.length !== this.#snapshots.length) {
      this.#snapshots.splice(0, this.#snapshots.length, ...retained);
    }
  }

  #appendAudit(input: {
    accountId: string;
    actorPrincipalId: string;
    deviceId: string | null;
    action: string;
    reason: string;
    revision: number | null;
    deliveryStatus: PolicyAuditEvent["deliveryStatus"];
    details: Record<string, unknown>;
  }): void {
    const now = Date.now();
    this.#auditHistory.push({
      id: randomUUID(),
      timestampMs: now,
      timestampIso: new Date(now).toISOString(),
      accountId: input.accountId,
      actorPrincipalId: input.actorPrincipalId,
      deviceId: input.deviceId,
      action: input.action,
      reason: input.reason,
      revision: input.revision,
      deliveryStatus: input.deliveryStatus,
      details: input.details,
    });
    if (this.#auditHistory.length > this.#maxAuditHistory) {
      this.#auditHistory.splice(
        0,
        this.#auditHistory.length - this.#maxAuditHistory,
      );
    }
  }

  #markAuditDelivery(
    deviceId: string,
    revision: number,
    status: PolicyAuditEvent["deliveryStatus"],
  ): void {
    for (const event of this.#auditHistory) {
      if (event.deviceId !== deviceId || event.revision === null) continue;
      if (event.revision === revision) {
        event.deliveryStatus = status;
      } else if (
        status === "confirmed_by_device" &&
        event.revision < revision &&
        (event.deliveryStatus === "pending_device_ack" ||
          event.deliveryStatus === "device_offline")
      ) {
        event.deliveryStatus = "confirmed_by_device";
      }
    }
  }

  #recordUsage(
    identity: ClientIdentity,
    role: PrincipalRole | "unregistered",
    deviceId: string,
    capability: string,
    status: "allowed" | "denied",
  ): void {
    const key = `${identity.accountId}::${identity.principalId}::${deviceId}`;
    const family = toolFamilyForCapability(capability);
    const existing = this.#identityUsage.get(key);
    const now = Date.now();
    if (!existing) {
      this.#identityUsage.set(key, {
        accountId: identity.accountId,
        principalId: identity.principalId,
        clientId: identity.clientId,
        role,
        deviceId,
        capabilitiesUsed: [capability],
        familiesUsed: family ? [family] : [],
        authorizedCount: status === "allowed" ? 1 : 0,
        deniedCount: status === "denied" ? 1 : 0,
        lastCapability: capability,
        lastStatus: status,
        lastUsedAtMs: now,
      });
      return;
    }
    if (!existing.capabilitiesUsed.includes(capability)) {
      existing.capabilitiesUsed.push(capability);
    }
    if (family && !existing.familiesUsed.includes(family)) {
      existing.familiesUsed.push(family);
    }
    if (status === "allowed") {
      existing.authorizedCount += 1;
    } else {
      existing.deniedCount += 1;
    }
    existing.role = role;
    existing.lastCapability = capability;
    existing.lastStatus = status;
    existing.lastUsedAtMs = now;
  }

  async #load(): Promise<void> {
    if (!this.#stateFile) return;
    let content: string;
    try {
      content = await readFile(this.#stateFile, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    const parsed = JSON.parse(content) as Partial<PersistedPolicyState>;
    if (parsed.version !== 1) return;
    for (const record of parsed.records ?? []) {
      this.#records.set(record.policy.device_id, record);
    }
    for (const snap of parsed.snapshots ?? []) {
      this.#snapshots.push(snap);
    }
    for (const event of (parsed.auditHistory ?? []).slice(-this.#maxAuditHistory)) {
      this.#auditHistory.push(event);
    }
    for (const usage of parsed.identityUsage ?? []) {
      this.#identityUsage.set(
        `${usage.accountId}::${usage.principalId}::${usage.deviceId}`,
        usage,
      );
    }
    for (const op of parsed.operators ?? []) {
      this.#operators.set(`${op.accountId}::${op.principalId}`, op);
    }
  }

  async #persist(): Promise<void> {
    if (!this.#stateFile) return;
    try {
      await mkdir(path.dirname(this.#stateFile), { recursive: true });
      const state: PersistedPolicyState = {
        version: 1,
        records: [...this.#records.values()],
        snapshots: retainSnapshotsForPersistence(this.#snapshots),
        auditHistory: this.#auditHistory.slice(-this.#maxAuditHistory),
        identityUsage: [...this.#identityUsage.values()],
        operators: [...this.#operators.values()],
      };
      const temporary = `${this.#stateFile}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#stateFile);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

const MAX_RECENT_SNAPSHOTS_PER_DEVICE = 120;

function retainSnapshotsForPersistence(
  snapshots: readonly PolicySnapshot[],
): PolicySnapshot[] {
  const byDevice = new Map<string, PolicySnapshot[]>();
  const baselineByDevice = new Map<string, PolicySnapshot>();
  for (const snap of snapshots) {
    if (snap.revision === 1 && !baselineByDevice.has(snap.deviceId)) {
      baselineByDevice.set(snap.deviceId, snap);
    }
    let list = byDevice.get(snap.deviceId);
    if (!list) {
      list = [];
      byDevice.set(snap.deviceId, list);
    }
    list.push(snap);
  }
  const keep = new Set<PolicySnapshot>(baselineByDevice.values());
  for (const list of byDevice.values()) {
    for (const recent of list.slice(-MAX_RECENT_SNAPSHOTS_PER_DEVICE)) {
      keep.add(recent);
    }
  }
  return snapshots.filter((snap) => keep.has(snap));
}

function applyMutationToPermissionSet(
  current: PrincipalPermissionSet,
  mutation: PolicyMutationInput,
): PrincipalPermissionSet {
  let base: PrincipalPermissionSet = mutation.profileId
    ? createProfilePermissionSet(
        current.principal_id,
        current.role,
        mutation.profileId,
      )
    : structuredClone(current);

  if (typeof mutation.universalPermissions === "boolean") {
    base.universal_permissions = mutation.universalPermissions;
  }

  const allowedFamilies = new Set<ToolFamily>(
    mutation.allowedFamilies ?? base.allowed_families,
  );
  const deniedFamilies = new Set<ToolFamily>(
    mutation.deniedFamilies ?? base.denied_families,
  );

  for (const fam of mutation.grantFamilies ?? []) {
    allowedFamilies.add(fam);
    deniedFamilies.delete(fam);
  }
  for (const fam of mutation.revokeFamilies ?? []) {
    allowedFamilies.delete(fam);
    deniedFamilies.add(fam);
  }

  if (mutation.allowedCapabilities) {
    assertCanonicalCapabilities(mutation.allowedCapabilities, "allowedCapabilities");
  }
  if (mutation.deniedCapabilities) {
    assertCanonicalCapabilities(mutation.deniedCapabilities, "deniedCapabilities");
  }
  if (mutation.grantCapabilities) {
    assertCanonicalCapabilities(mutation.grantCapabilities, "grantCapabilities");
  }
  if (mutation.revokeCapabilities) {
    assertCanonicalCapabilities(mutation.revokeCapabilities, "revokeCapabilities");
  }

  const allowedCapabilities = new Set<string>(
    mutation.allowedCapabilities ?? base.allowed_capabilities,
  );
  const deniedCapabilities = new Set<string>(
    mutation.deniedCapabilities ?? base.denied_capabilities,
  );

  for (const cap of mutation.grantCapabilities ?? []) {
    allowedCapabilities.add(cap);
    deniedCapabilities.delete(cap);
  }
  for (const cap of mutation.revokeCapabilities ?? []) {
    allowedCapabilities.delete(cap);
    deniedCapabilities.add(cap);
  }

  base.allowed_families = [...allowedFamilies].sort();
  base.denied_families = [...deniedFamilies].sort();
  base.allowed_capabilities = [...allowedCapabilities].sort();
  base.denied_capabilities = [...deniedCapabilities].sort();

  if (mutation.allowedRoots) {
    base.allowed_roots = [...mutation.allowedRoots];
  }
  if (typeof mutation.allowDestructive === "boolean") {
    base.allow_destructive = mutation.allowDestructive;
  }
  if (!mutation.profileId) {
    const isFullUniversal =
      base.universal_permissions &&
      base.denied_families.length === 0 &&
      base.denied_capabilities.length === 0 &&
      base.allowed_families.length === ALL_TOOL_FAMILIES.length;
    base.profile_id = isFullUniversal ? "universal" : "custom";
  }

  return base;
}
