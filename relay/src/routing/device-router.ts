import { randomUUID } from "node:crypto";

import type {
  InvocationEnvelope,
  ResultEnvelope,
} from "@tetherplane/protocol";

import type { ClientIdentity } from "../auth/static-auth.ts";
import type { DeviceRegistry } from "../devices/registry.ts";

export type RelayToDeviceMessage =
  | {
      type: "invoke";
      routeId: string;
      invocation: InvocationEnvelope;
    }
  | {
      type: "policy";
      version: number;
      allowedCapabilities: string[];
    };

export type DeviceToRelayMessage =
  | {
      type: "result";
      routeId: string;
      result: ResultEnvelope;
    }
  | {
      type: "policy_ack";
      version: number;
      status: "applied" | "rejected";
      appliedCapabilities: string[];
      reason?: string;
    };

export type DevicePolicySyncStatus = {
  deviceId: string;
  online: boolean;
  revokedAt: string | null;
  desiredVersion: number;
  desiredCapabilities: string[];
  acknowledgedVersion: number;
  lastStatus: "applied" | "rejected" | null;
  lastReason: string | null;
  appliedCapabilities: string[];
  pending: boolean;
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
};
type PendingRoute = {
  deviceId: string;
  generation: string;
  requestId: string;
  resolve(result: ResultEnvelope): void;
  timer: NodeJS.Timeout;
};

// Owner desired state per device (S4). Desired survives reconnects (it is
// owner intent, re-pushed on every connect); acknowledgments are
// generation-scoped and reset on every new connection. The relay never
// grants: it stores, forwards, and reports convergence only.
type DevicePolicySync = {
  desiredVersion: number;
  desiredCapabilities: string[];
  saving: boolean;
  acknowledgedVersion: number;
  generation: string | null;
  lastStatus: "applied" | "rejected" | null;
  lastReason: string | null;
  appliedCapabilities: string[];
};

const MAX_POLICY_CAPABILITIES = 1024;
const MAX_POLICY_CAPABILITY_LENGTH = 256;

export class DeviceRouter {
  readonly #registry: DeviceRegistry;
  readonly #timeoutMs: number;
  readonly #pushTimeoutMs: number;
  readonly #connections = new Map<string, ActiveConnection>();
  readonly #pending = new Map<string, PendingRoute>();
  readonly #policies = new Map<string, DevicePolicySync>();
  readonly #policyWrites = new Map<string, Promise<void>>();

  constructor(options: {
    registry: DeviceRegistry;
    timeoutMs?: number;
    pushTimeoutMs?: number;
  }) {
    this.#registry = options.registry;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#pushTimeoutMs = options.pushTimeoutMs ?? 5_000;
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
    };
    this.#connections.set(input.deviceId, connection);
    this.#onReconnectPushPolicy(connection);

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

  /**
   * Owner sets desired capabilities for one device. Versions increase
   * monotonically per device; only the latest version is ever pushed,
   * so rapid concurrent sets converge on the newest intent. Desired
   * state persists in the registry before publication; a storage
   * failure preserves the previous committed revision and throws, so the owner
   * never sees a phantom version. Pushes to the live socket when
   * online (bounded); offline devices receive the current desired
   * version on their next connect.
   */
  async setDesiredPolicy(
    accountId: string,
    deviceId: string,
    allowedCapabilities: string[],
  ): Promise<{ version: number; pushed: boolean }> {
    // Serialize writes for one device, so each caller gets its own
    // committed revision and failed writes cannot roll back newer ones.
    const capabilities = validatePolicyCapabilities(allowedCapabilities);
    const previous = this.#policyWrites.get(deviceId) ?? Promise.resolve();
    const result = previous.then(() =>
      this.#saveDesiredPolicy(accountId, deviceId, capabilities),
    );
    const tail = result.then(() => undefined, () => undefined);
    this.#policyWrites.set(deviceId, tail);
    try {
      return await result;
    } finally {
      if (this.#policyWrites.get(deviceId) === tail) {
        this.#policyWrites.delete(deviceId);
      }
    }
  }

  async #saveDesiredPolicy(
    accountId: string,
    deviceId: string,
    capabilities: string[],
  ): Promise<{ version: number; pushed: boolean }> {
    const binding = this.#registry.getDevice(deviceId);
    if (!binding || binding.accountId !== accountId || binding.revokedAt !== null) {
      throw new Error("device is not available for policy sync");
    }
    const sync = this.#policyFor(deviceId);
    const version = sync.desiredVersion + 1;
    sync.saving = true;
    try {
      await this.#registry.setDesiredPolicy(deviceId, {
        version,
        allowedCapabilities: capabilities,
      });
      sync.desiredVersion = version;
      sync.desiredCapabilities = capabilities;
    } finally {
      // During a save, hold requests; reconnect may re-push the previous
      // committed revision, never the proposed but unsaved revision.
      sync.saving = false;
    }
    const connection = this.#connections.get(deviceId);
    if (!connection) return { version, pushed: false };
    try {
      await this.#pushPolicy(connection, sync);
      return { version, pushed: true };
    } catch {
      return { version, pushed: false };
    }
  }

  getPolicySync(
    accountId: string,
    deviceId: string,
  ): DevicePolicySyncStatus | null {
    const binding = this.#registry.getDevice(deviceId);
    if (!binding || binding.accountId !== accountId) {
      return null;
    }
    return this.#syncStatus(binding.deviceId, binding.revokedAt);
  }

  listPolicySync(accountId: string): DevicePolicySyncStatus[] {
    return this.#registry
      .listDevices(accountId)
      .map((binding) => this.#syncStatus(binding.deviceId, binding.revokedAt));
  }

  #policyFor(deviceId: string): DevicePolicySync {
    let sync = this.#policies.get(deviceId);
    if (!sync) {
      // Lazy hydration: persisted desired survives relay restarts while
      // acknowledgments (generation-scoped) always start over.
      const persisted = this.#registry.getDesiredPolicy(deviceId);
      sync = {
        desiredVersion: persisted?.version ?? 0,
        desiredCapabilities: persisted ? [...persisted.allowedCapabilities] : [],
        saving: false,
        acknowledgedVersion: 0,
        generation: null,
        lastStatus: null,
        lastReason: null,
        appliedCapabilities: [],
      };
      this.#policies.set(deviceId, sync);
    }
    return sync;
  }

  #syncStatus(deviceId: string, revokedAt: string | null): DevicePolicySyncStatus {
    const sync = this.#policyFor(deviceId);
    return {
      deviceId,
      online: this.#connections.has(deviceId),
      revokedAt,
      desiredVersion: sync.desiredVersion,
      desiredCapabilities: [...sync.desiredCapabilities],
      acknowledgedVersion: sync.acknowledgedVersion,
      lastStatus: sync.lastStatus,
      lastReason: sync.lastReason,
      appliedCapabilities: [...sync.appliedCapabilities],
      pending:
        sync.saving || (sync.desiredVersion > 0 && sync.acknowledgedVersion !== sync.desiredVersion),
    };
  }

  #onReconnectPushPolicy(connection: ActiveConnection): void {
    const sync = this.#policyFor(connection.deviceId);
    if (sync.desiredVersion === 0) {
      return;
    }
    // New generation: prior acks belong to a dead socket. Reset and
    // re-push current desired; the device re-applies from its own
    // fresh per-connection baseline and re-acknowledges.
    sync.acknowledgedVersion = 0;
    sync.generation = connection.generation;
    sync.lastStatus = null;
    sync.lastReason = null;
    sync.appliedCapabilities = [];
    void this.#pushPolicy(connection, sync).catch(() => undefined);
  }

  async #pushPolicy(
    connection: ActiveConnection,
    sync: DevicePolicySync,
  ): Promise<void> {
    // Bounded push: a wedged socket must fail the push, never hang the
    // owner call. Undelivered versions stay pending and re-push.
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        connection.send({
          type: "policy",
          version: sync.desiredVersion,
          allowedCapabilities: [...sync.desiredCapabilities],
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("policy push timed out")),
            this.#pushTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #receivePolicyAck(
    connection: ActiveConnection,
    message: Extract<DeviceToRelayMessage, { type: "policy_ack" }>,
  ): void {
    const sync = this.#policies.get(connection.deviceId);
    if (!sync) return;
    if (typeof message.version !== "number" || message.version <= 0) return;
    // Monotonic per generation: stale, duplicate, or future acks can
    // never move acknowledged state backward (or claim unsent versions).
    if (sync.generation !== connection.generation) {
      sync.acknowledgedVersion = 0;
      sync.generation = connection.generation;
      sync.lastStatus = null;
      sync.lastReason = null;
    }
    if (
      message.version <= sync.acknowledgedVersion ||
      message.version > sync.desiredVersion
    ) {
      return;
    }
    if (message.status !== "applied" && message.status !== "rejected") return;
    sync.acknowledgedVersion = message.version;
    sync.lastStatus = message.status;
    sync.lastReason =
      typeof message.reason === "string" && message.reason ? message.reason : null;
    sync.appliedCapabilities = Array.isArray(message.appliedCapabilities)
      ? message.appliedCapabilities.filter((entry): entry is string => typeof entry === "string")
      : [];
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
    // Hold while sync is pending: until the device acknowledges the
    // current desired version, routing would execute under the wider
    // ceiling instead of the configured restrictions.
    const sync = this.#policyFor(connection.deviceId);
    if (
      sync.saving ||
      (sync.desiredVersion > 0 && sync.acknowledgedVersion !== sync.desiredVersion)
    ) {
      return errorResult(
        invocation.request_id,
        "timeout",
        `device policy sync pending (desired v${sync.desiredVersion}); retry shortly`,
        "retry the call after the device acknowledges the current desired version",
      );
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

  #receive(
    connection: ActiveConnection,
    message: DeviceToRelayMessage,
  ): void {
    if (message.type === "policy_ack") {
      this.#receivePolicyAck(connection, message);
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
    if (this.#isCurrent(connection)) {
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

function validatePolicyCapabilities(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new Error("allowedCapabilities must be an array of capability names");
  }
  if (input.length > MAX_POLICY_CAPABILITIES) {
    throw new Error(
      `allowedCapabilities must list at most ${MAX_POLICY_CAPABILITIES} capabilities`,
    );
  }
  return input.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error("allowedCapabilities entries must be non-empty strings");
    }
    if (entry.length > MAX_POLICY_CAPABILITY_LENGTH) {
      throw new Error(
        `allowedCapabilities entries must be at most ${MAX_POLICY_CAPABILITY_LENGTH} characters`,
      );
    }
    return entry;
  });
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
      details: {},
    },
    verification: "failed",
    continuation: null,
    policy: null,
    timing: { duration_ms: 0 },
  };
}
