import { randomUUID } from "node:crypto";

import type {
  InvocationEnvelope,
  ResultEnvelope,
} from "@tetherplane/protocol";

import type { ClientIdentity } from "../auth/static-auth.ts";
import type { DeviceRegistry } from "../devices/registry.ts";

export type RelayToDeviceMessage = {
  type: "invoke";
  routeId: string;
  invocation: InvocationEnvelope;
};

export type DeviceToRelayMessage = {
  type: "result";
  routeId: string;
  result: ResultEnvelope;
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

export class DeviceRouter {
  readonly #registry: DeviceRegistry;
  readonly #timeoutMs: number;
  readonly #connections = new Map<string, ActiveConnection>();
  readonly #pending = new Map<string, PendingRoute>();

  constructor(options: {
    registry: DeviceRegistry;
    timeoutMs?: number;
  }) {
    this.#registry = options.registry;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
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
      recovery_hint: null,
      details: {},
    },
    verification: "failed",
    continuation: null,
    policy: null,
    timing: { duration_ms: 0 },
  };
}
