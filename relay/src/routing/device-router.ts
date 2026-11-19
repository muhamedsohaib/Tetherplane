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
  readonly #connections = new Map<string, ActiveConnection>();
  readonly #pending = new Map<string, PendingRoute>();
  readonly #inFlightControl = new Set<Promise<void>>();

  constructor(options: {
    registry: DeviceRegistry;
    policyStore?: PolicyStore;
    enforcePolicy?: boolean;
    timeoutMs?: number;
  }) {
    this.#registry = options.registry;
    this.#policyStore = options.policyStore ?? null;
    this.#enforcePolicy = options.enforcePolicy ?? true;
    this.#timeoutMs = options.timeoutMs ?? 30_000;

    if (this.#policyStore) {
      this.#policyStore.setSyncHooks({
        pushPolicy: (deviceId, policy) =>
          this.pushPolicy(deviceId, policy),
        isOnline: (deviceId) => this.isOnline(deviceId),
      });
    }
  }

  connectDevice(input: {
    accountId: string;
    deviceId: string;
    send(message: RelayToDeviceMessage): Promise<void>;
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
    try {
      const syncMsg: RelayPolicySyncMessage = {
        type: "policy_sync",
        policy,
      };
      await connection.send(syncMsg as unknown as RelayToDeviceMessage);
      return true;
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
      const evaluation =
        this.#policyStore.evaluateAndRecordInvocation({
          identity,
          deviceId: connection.deviceId,
          capability: invocation.capability,
        });
      if (!evaluation.allowed) {
        return errorResult(
          invocation.request_id,
          "permission_denied",
          evaluation.message ?? "capability is not permitted",
          evaluation.recoveryHint ?? null,
          evaluation.denialKind
            ? { denial_kind: evaluation.denialKind }
            : {},
        );
      }
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
      if (!policyStore) return;
      this.#enqueueControl(connection, async () => {
        const policy = await policyStore.handleDeviceHello({
          deviceId: connection.deviceId,
          accountId: connection.accountId,
          appliedPolicyRevision: message.appliedPolicyRevision ?? null,
          status: message.status ?? null,
          capabilities: message.capabilities ?? null,
        });
        if (policy && this.#isCurrent(connection)) {
          await this.pushPolicy(connection.deviceId, policy);
        }
      });
      return;
    }

    if (message.type === "policy_ack") {
      const policyStore = this.#policyStore;
      if (!policyStore) return;
      this.#enqueueControl(connection, () =>
        policyStore.handlePolicyAck({
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
        }),
      );
      return;
    }

    if (message.type === "device_telemetry") {
      const policyStore = this.#policyStore;
      if (!policyStore || message.deviceId !== connection.deviceId) {
        return;
      }
      this.#enqueueControl(connection, () =>
        policyStore.handleDeviceTelemetry({
          deviceId: connection.deviceId,
          accountId: connection.accountId,
          status: message.status ?? null,
          capabilities: message.capabilities ?? null,
        }),
      );
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

function errorResult(
  requestId: string,
  code:
    | "invalid_arguments"
    | "capability_unavailable"
    | "permission_denied"
    | "timeout"
    | "disconnected"
    | "provider_failure",
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
