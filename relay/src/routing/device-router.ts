import { randomUUID } from "node:crypto";

import type {
  InvocationEnvelope,
  ResultEnvelope,
} from "@tetherplane/protocol";

import type { ClientIdentity } from "../auth/static-auth.ts";
import type { DeviceRegistry } from "../devices/registry.ts";
import type {
  PolicyStore,
  SynchronizedDevicePolicy,
} from "../policy/policy-store.ts";

export type RelayToDeviceMessage = {
  type: "invoke";
  routeId: string;
  invocation: InvocationEnvelope;
};

export type RelayPolicySyncMessage = {
  type: "policy_sync";
  policy: SynchronizedDevicePolicy;
};

export type DeviceToRelayMessage =
  | {
      type: "result";
      routeId: string;
      result: ResultEnvelope;
    }
  | {
      type: "device_hello";
      deviceId: string;
      appliedPolicyRevision: number | null;
      heartbeatVersion?: number;
      status?: Record<string, unknown> | null;
      capabilities?: Record<string, unknown> | null;
    }
  | {
      type: "policy_ack";
      deviceId: string;
      revision: number;
      currentRevision?: number | null;
      applied: boolean;
      appliedAtMs?: number;
      status?: Record<string, unknown> | null;
      capabilities?: Record<string, unknown> | null;
      error?: string | null;
    }
  | {
      type: "device_telemetry";
      deviceId: string;
      status?: Record<string, unknown> | null;
      capabilities?: Record<string, unknown> | null;
    };

export type DeviceConnectionHandle = {
  receive(message: DeviceToRelayMessage): void;
  disconnect(): void;
};

type ActiveConnection = {
  accountId: string;
  deviceId: string;
  generation: string;
  send(message: RelayToDeviceMessage): Promise<void>;
  controlQueue: Promise<void>;
  controlDepth: number;
  retire: () => void;
  syncAware: boolean;
  pendingPolicyReports: number;
  evidence: { status: Record<string, unknown> | null; capabilities: Record<string, unknown> | null; appliedRevision: number | null };
};

type PendingRoute = {
  deviceId: string;
  generation: string;
  requestId: string;
  resolve(result: ResultEnvelope): void;
  timer: NodeJS.Timeout;
};

export class DeviceRouter {
  readonly #registry: DeviceRegistry;
  readonly #policyStore: PolicyStore | null;
  readonly #enforcePolicy: boolean;
  readonly #timeoutMs: number;
  readonly #maxPendingRoutesPerDevice: number;
  readonly #maxPendingRoutes: number;
  readonly #maxControlReportsPerDevice: number;
  readonly #maxControlReports: number;
  readonly #connections = new Map<string, ActiveConnection>();
  readonly #pending = new Map<string, PendingRoute>();
  readonly #inFlightControl = new Set<Promise<void>>();

  constructor(options: {
    registry: DeviceRegistry;
    policyStore?: PolicyStore;
    enforcePolicy?: boolean;
    timeoutMs?: number;
    maxPendingRoutesPerDevice?: number;
    maxPendingRoutes?: number;
    maxControlReportsPerDevice?: number;
    maxControlReports?: number;
  }) {
    this.#registry = options.registry;
    this.#policyStore = options.policyStore ?? null;
    this.#enforcePolicy = options.enforcePolicy ?? true;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxPendingRoutesPerDevice = positiveBound(options.maxPendingRoutesPerDevice ?? 32);
    this.#maxPendingRoutes = positiveBound(options.maxPendingRoutes ?? 256);
    this.#maxControlReportsPerDevice = positiveBound(options.maxControlReportsPerDevice ?? 32);
    this.#maxControlReports = positiveBound(options.maxControlReports ?? 256);

    if (this.#policyStore) {
      this.#policyStore.setSyncHooks({
        pushPolicy: (deviceId, policy) =>
          this.pushPolicy(deviceId, policy),
        isOnline: (deviceId) => this.isOnline(deviceId),
        connectionEvidence: (deviceId) => {
          const connection = this.#connections.get(deviceId);
          if (!connection) return null;
          return connection.pendingPolicyReports > 0
            ? { ...connection.evidence, appliedRevision: null }
            : connection.evidence;
        },
      });
    }
  }

  connectDevice(input: {
    accountId: string;
    deviceId: string;
    send(message: RelayToDeviceMessage): Promise<void>;
    retire?: () => void;
  }): DeviceConnectionHandle {
    const binding = this.#registry.getDevice(input.deviceId);
    if (
      !binding ||
      binding.accountId !== input.accountId ||
      binding.revokedAt !== null
    ) {
      throw new Error("device connection is not authorized");
    }

    const previous = this.#connections.get(input.deviceId);
    if (previous) this.#disconnect(previous);
    const connection: ActiveConnection = {
      accountId: input.accountId,
      deviceId: input.deviceId,
      generation: randomUUID(),
      send: input.send,
      controlQueue: Promise.resolve(),
      controlDepth: 0,
      retire: input.retire ?? (() => {}),
      syncAware: false,
      pendingPolicyReports: 0,
      evidence: { status: null, capabilities: null, appliedRevision: null },
    };
    this.#connections.set(input.deviceId, connection);
    this.#policyStore?.notifyChange(input.accountId);

    return {
      receive: (message) => {
        if (!this.#isCurrent(connection)) return;
        this.#receive(connection, message);
      },
      disconnect: () => {
        if (!this.#isCurrent(connection)) return;
        this.#disconnect(connection);
      },
    };
  }

  disconnectDevice(deviceId: string): void {
    const connection = this.#connections.get(deviceId);
    if (connection) this.#disconnect(connection);
  }

  isOnline(deviceId: string): boolean {
    return this.#connections.has(deviceId);
  }

  async pushPolicy(
    deviceId: string,
    policy: SynchronizedDevicePolicy,
  ): Promise<boolean> {
    if (!this.#enforcePolicy) return false;
    const connection = this.#connections.get(deviceId);
    if (!connection) return false;
    const desired = this.#policyStore?.getRecord(deviceId);
    if (desired && desired.desiredRevision !== policy.revision) return false;
    try {
      const syncMsg: RelayPolicySyncMessage = {
        type: "policy_sync",
        policy,
      };
      // A silent transport must not hold the serialized authority writer
      // forever. The committed policy remains pending; do not replay here.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.min(this.#timeoutMs, 5_000));
        });
        const sent = await Promise.race([
          connection.send(syncMsg as unknown as RelayToDeviceMessage).then(() => true, () => false),
          deadline,
        ]);
        return sent && this.#isCurrent(connection);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  async call(
    identity: ClientIdentity,
    invocation: InvocationEnvelope,
  ): Promise<ResultEnvelope> {
    const resolved = this.#resolveConnection(
      identity.accountId,
      invocation.device_id,
    );
    if ("error" in resolved) {
      return errorResult(
        invocation.request_id,
        resolved.error.code,
        resolved.error.message,
      );
    }
    const connection = resolved.connection;

    if (this.#policyStore && this.#enforcePolicy) {
      if (this.#policyStore.isAuthorityChangePending()) {
        return errorResult(invocation.request_id, "timeout",
          "device policy sync pending while authority is being saved");
      }
      const capabilities = batchCapabilities(invocation.capability, invocation.arguments);
      if (capabilities === null) {
        return errorResult(invocation.request_id, "invalid_arguments",
          "batch capability inventory is malformed or exceeds verification bounds");
      }
      // Authorize every child before forwarding the batch. The local
      // broker still evaluates each operation at execution time.
      for (const capability of capabilities) {
        const evaluation = this.#policyStore.evaluateAndRecordInvocation({
          identity,
          deviceId: connection.deviceId,
          capability,
        });
        if (!evaluation.allowed) {
          return errorResult(
            invocation.request_id,
            "permission_denied",
            evaluation.message ?? "capability is not permitted",
            evaluation.recoveryHint ?? null,
            evaluation.denialKind ? { denial_kind: evaluation.denialKind } : {},
          );
        }
      }
      const record = this.#policyStore.getRecord(connection.deviceId);
      if (!record) {
        return errorResult(invocation.request_id, "permission_denied", "device policy is missing");
      }
      // Preserve the original universal revision-1 legacy path only
      // before any sync evidence or policy change has existed.
      const owner = record.policy.owner_policy;
      const legacyDefault = !connection.syncAware && record.desiredRevision === 1 &&
        record.appliedRevision === null && record.lastAckError === null &&
        !record.policy.emergency_lockdown && owner.universal_permissions &&
        owner.denied_families.length === 0 && owner.denied_capabilities.length === 0 &&
        Object.keys(record.policy.operator_policies).length === 0;
      if (!legacyDefault && (connection.pendingPolicyReports > 0 ||
          record.lastAckError !== null ||
          record.appliedRevision !== record.desiredRevision ||
          connection.evidence.appliedRevision !== record.desiredRevision)) {
        return errorResult(invocation.request_id, "timeout",
          "device policy sync pending; wait for current-generation acknowledgement",
          "Inspect owner dashboard synchronization before resubmitting.");
      }
    }

    // Refuse excess work before cloning, sending, or allocating timers.
    // Bounds are independent of the agent's own ordered execution queue.
    let devicePending = 0;
    for (const pending of this.#pending.values()) {
      if (pending.deviceId === connection.deviceId &&
          pending.generation === connection.generation) devicePending++;
    }
    if (this.#pending.size >= this.#maxPendingRoutes ||
        devicePending >= this.#maxPendingRoutesPerDevice) {
      return errorResult(invocation.request_id, "resource_conflict",
        "relay pending route capacity exceeded", null, {dispatched: false});
    }

    const routedInvocation: InvocationEnvelope = {
      ...structuredClone(invocation),
      device_id: connection.deviceId,
      principal_id: identity.principalId,
      actor: {
        id: identity.clientId,
        kind: "ai_client",
      },
    };
    const routeId = randomUUID();
    const message: RelayToDeviceMessage = {
      type: "invoke",
      routeId,
      invocation: routedInvocation,
    };

    return new Promise<ResultEnvelope>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(routeId);
        if (!pending) return;
        this.#pending.delete(routeId);
        resolve(
          errorResult(
            pending.requestId,
            "timeout",
            "relay route timed out waiting for the device",
          ),
        );
      }, this.#timeoutMs);

      this.#pending.set(routeId, {
        deviceId: connection.deviceId,
        generation: connection.generation,
        requestId: invocation.request_id,
        resolve,
        timer,
      });

      void connection.send(message).catch(() => {
        const pending = this.#pending.get(routeId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(routeId);
        resolve(
          errorResult(
            invocation.request_id,
            "disconnected",
            "device connection closed before request delivery",
          ),
        );
      });
    });
  }

  async drainControl(): Promise<void> {
    while (this.#inFlightControl.size > 0) {
      await Promise.all([...this.#inFlightControl]);
    }
  }

  #enqueueControl(
    connection: ActiveConnection,
    task: () => Promise<void>,
  ): void {
    if (!this.#isCurrent(connection)) return;
    if (connection.controlDepth >= this.#maxControlReportsPerDevice ||
        this.#inFlightControl.size >= this.#maxControlReports) {
      // Do not silently drop a policy ACK or keep routing on stale
      // authority. Retire only this generation and resynchronize.
      this.#disconnect(connection);
      connection.retire();
      return;
    }
    connection.controlDepth++;
    let tracked: Promise<void>;
    tracked = connection.controlQueue
      .then(async () => {
        if (!this.#isCurrent(connection)) return;
        await task();
      })
      .catch(() => {
        // Control plane errors must not wedge subsequent messages or raise unhandled rejections
      })
      .finally(() => {
        connection.controlDepth--;
        this.#inFlightControl.delete(tracked);
      });
    connection.controlQueue = tracked;
    this.#inFlightControl.add(tracked);
  }

  #receive(
    connection: ActiveConnection,
    message: DeviceToRelayMessage,
  ): void {
    if (message.type === "device_hello") {
      const policyStore = this.#policyStore;
      if (!policyStore || message.deviceId !== connection.deviceId) return;
      connection.syncAware = true;
      connection.pendingPolicyReports += 1;
      connection.evidence.appliedRevision = null;
      this.#enqueueControl(connection, async () => {
        try {
          const policy = await policyStore.handleDeviceHello({
            deviceId: connection.deviceId,
            accountId: connection.accountId,
            appliedPolicyRevision: message.appliedPolicyRevision ?? null,
            status: message.status ?? null,
            capabilities: message.capabilities ?? null,
          });
          // Never publish readiness or an acknowledged revision before
          // the control record has been saved for this generation.
          if (this.#isCurrent(connection)) {
            connection.evidence = {
              status: message.status ?? null,
              capabilities: message.capabilities ?? null,
              appliedRevision: typeof message.appliedPolicyRevision === "number" &&
                Number.isSafeInteger(message.appliedPolicyRevision) && message.appliedPolicyRevision >= 1
                ? message.appliedPolicyRevision : null,
            };
            if (policy) await this.pushPolicy(connection.deviceId, policy);
          }
        } catch (error) {
          connection.evidence.appliedRevision = null;
          throw error;
        } finally {
          connection.pendingPolicyReports -= 1;
          if (this.#isCurrent(connection)) policyStore.notifyChange(connection.accountId);
        }
      });
      return;
    }

    if (message.type === "policy_ack") {
      const policyStore = this.#policyStore;
      if (!policyStore || message.deviceId !== connection.deviceId) return;
      if (!Number.isSafeInteger(message.revision) || message.revision < 1) return;
      connection.syncAware = true;
      connection.pendingPolicyReports += 1;
      this.#enqueueControl(connection, async () => {
        try {
          await policyStore.handlePolicyAck({
            deviceId: connection.deviceId,
            accountId: connection.accountId,
            revision: message.revision,
            ...(typeof message.currentRevision === "number"
              ? { currentRevision: message.currentRevision }
              : {}),
            applied: message.applied,
            ...(typeof message.appliedAtMs === "number"
              ? { appliedAtMs: message.appliedAtMs }
              : {}),
            status: message.status ?? null,
            capabilities: message.capabilities ?? null,
            error: message.error ?? null,
          });
          if (this.#isCurrent(connection)) {
            if (message.status) connection.evidence.status = message.status;
            if (message.capabilities) connection.evidence.capabilities = message.capabilities;
            // An older ACK must not borrow a revision persisted by a
            // previous connection. Only current-generation reports count.
            connection.evidence.appliedRevision = message.applied
              ? Math.max(connection.evidence.appliedRevision ?? 0, message.revision)
              : typeof message.currentRevision === "number" && Number.isSafeInteger(message.currentRevision) &&
                  message.currentRevision >= 1 ? message.currentRevision : null;
          }
        } catch (error) {
          connection.evidence.appliedRevision = null;
          throw error;
        } finally {
          connection.pendingPolicyReports -= 1;
          if (this.#isCurrent(connection)) policyStore.notifyChange(connection.accountId);
        }
      });
      return;
    }

    if (message.type === "device_telemetry") {
      const policyStore = this.#policyStore;
      if (!policyStore || message.deviceId !== connection.deviceId) {
        return;
      }
      this.#enqueueControl(connection, () => {
        if (message.status) connection.evidence.status = message.status;
        if (message.capabilities) connection.evidence.capabilities = message.capabilities;
        return policyStore.handleDeviceTelemetry({
          deviceId: connection.deviceId,
          accountId: connection.accountId,
          status: message.status ?? null,
          capabilities: message.capabilities ?? null,
        });
      });
      return;
    }

    if (message.type !== "result") return;
    const pending = this.#pending.get(message.routeId);
    if (
      !pending ||
      pending.deviceId !== connection.deviceId ||
      pending.generation !== connection.generation
    ) {
      return;
    }

    clearTimeout(pending.timer);
    this.#pending.delete(message.routeId);
    if (message.result.request_id !== pending.requestId) {
      pending.resolve(
        errorResult(
          pending.requestId,
          "provider_failure",
          "device result request_id did not match routed request",
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  #disconnect(connection: ActiveConnection): void {
    const wasCurrent = this.#isCurrent(connection);
    if (wasCurrent) {
      this.#connections.delete(connection.deviceId);
    }
    for (const [routeId, pending] of this.#pending) {
      if (
        pending.deviceId !== connection.deviceId ||
        pending.generation !== connection.generation
      ) {
        continue;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(routeId);
      pending.resolve(
        errorResult(
          pending.requestId,
          "disconnected",
          "device disconnected while request was in flight",
        ),
      );
    }
    if (wasCurrent) {
      this.#policyStore?.notifyChange(connection.accountId);
    }
  }

  #isCurrent(connection: ActiveConnection): boolean {
    return (
      this.#connections.get(connection.deviceId)?.generation ===
      connection.generation
    );
  }

  #resolveConnection(
    accountId: string,
    requestedDeviceId: string | null,
  ):
    | { connection: ActiveConnection }
    | {
        error: {
          code:
            | "invalid_arguments"
            | "capability_unavailable"
            | "permission_denied"
            | "disconnected";
          message: string;
        };
      } {
    if (requestedDeviceId) {
      const binding = this.#registry.getDevice(requestedDeviceId);
      if (!binding) {
        return {
          error: {
            code: "capability_unavailable",
            message: "requested device is unknown",
          },
        };
      }
      if (
        binding.accountId !== accountId ||
        binding.revokedAt !== null
      ) {
        return {
          error: {
            code: "permission_denied",
            message: "requested device is not authorized for this account",
          },
        };
      }
      const connection = this.#connections.get(requestedDeviceId);
      return connection
        ? { connection }
        : {
            error: {
              code: "disconnected",
              message: "requested device is offline",
            },
          };
    }

    const online = this.#registry
      .listDevices(accountId)
      .filter(
        (device) =>
          device.revokedAt === null &&
          this.#connections.has(device.deviceId),
      );
    if (online.length === 0) {
      return {
        error: {
          code: "disconnected",
          message: "no paired device is online",
        },
      };
    }
    if (online.length > 1) {
      return {
        error: {
          code: "invalid_arguments",
          message: "device_id is required when multiple devices are online",
        },
      };
    }
    const deviceId = online[0]!.deviceId;
    return { connection: this.#connections.get(deviceId)! };
  }
}

// Bounded inspection of canonical batch children. No schema alias or
// caller-supplied principal is accepted here.
function batchCapabilities(capability: string, args: unknown): string[] | null {
  const capabilities: string[] = [];
  const visit = (name: string, value: unknown, depth: number): boolean => {
    if (depth > 8 || capabilities.length >= 129 || !name) return false;
    capabilities.push(name);
    if (name !== "batch.execute") return true;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const operations = (value as Record<string, unknown>).operations;
    if (!Array.isArray(operations) || operations.length > 128) return false;
    for (const operation of operations) {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) return false;
      const child = operation as Record<string, unknown>;
      if (typeof child.capability !== "string" ||
          !visit(child.capability, child.arguments, depth + 1)) return false;
    }
    return true;
  };
  return visit(capability, args, 0) ? capabilities : null;
}

function positiveBound(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("relay capacity must be a positive safe integer");
  }
  return value;
}

function errorResult(
  requestId: string,
  code:
    | "invalid_arguments"
    | "capability_unavailable"
    | "permission_denied"
    | "timeout"
    | "disconnected"
    | "provider_failure"
    | "resource_conflict",
  message: string,
  recoveryHint: string | null = null,
  details: Record<string, unknown> = {},
): ResultEnvelope {
  return {
    protocol_version: "1.0",
    request_id: requestId,
    status: "error",
    data: null,
    delta: null,
    error: {
      code,
      message,
      recovery_hint: recoveryHint,
      details,
    },
    verification: "failed",
    continuation: null,
    policy: null,
    timing: { duration_ms: 0 },
  };
}
