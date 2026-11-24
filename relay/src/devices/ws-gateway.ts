import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";

import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";

import type { DeviceRegistry } from "./registry.ts";
import type {
  DeviceRouter,
  DeviceConnectionHandle,
  DeviceToRelayMessage,
  RelayToDeviceMessage,
} from "../routing/device-router.ts";

const DEVICE_ID_HEADER = "x-tetherplane-device-id";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

type DisconnectReason =
  | "peer_closed"
  | "socket_error"
  | "heartbeat_timeout"
  | "heartbeat_send_failed"
  | "superseded"
  | "explicit_disconnect"
  | "gateway_shutdown";

export type DeviceConnectionEvent = {
  component: "device_websocket";
  event: "connected" | "disconnected";
  device_id: string;
  session_id: string;
  at: string;
  session_ms: number;
  last_pong_age_ms: number | null;
  reason?: DisconnectReason;
  close_code?: number;
};

type LiveDevice = {
  socket: WebSocket;
  connection: DeviceConnectionHandle;
  sessionId: string;
  startedAt: number;
  lastPongAt: number | null;
  pendingPing: Buffer | null;
  heartbeatTimer: NodeJS.Timeout | null;
};

function validateHeartbeatMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error("device heartbeat interval and timeout must be positive timer values");
  }
  return value;
}

export class DeviceWebSocketGateway {
  readonly #registry: DeviceRegistry;
  readonly #router: DeviceRouter;
  readonly #server = new WebSocketServer({ noServer: true });
  readonly #live = new Map<string, LiveDevice>();
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #onConnectionEvent: (event: DeviceConnectionEvent) => void;
  #closed = false;
  #attachedServer: Server | null = null;
  #upgradeHandler:
    | ((request: IncomingMessage, socket: any, head: Buffer) => void)
    | null = null;

  constructor(options: {
    registry: DeviceRegistry;
    router: DeviceRouter;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    onConnectionEvent?: (event: DeviceConnectionEvent) => void;
  }) {
    this.#registry = options.registry;
    this.#router = options.router;
    this.#heartbeatIntervalMs = validateHeartbeatMs(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    this.#heartbeatTimeoutMs = validateHeartbeatMs(
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
    );
    this.#onConnectionEvent = options.onConnectionEvent ?? (
      (event) => console.error(JSON.stringify(event))
    );
  }

  attach(server: Server, pathname = "/device"): void {
    if (this.#closed) {
      throw new Error("device websocket gateway is closed");
    }
    if (this.#attachedServer) {
      throw new Error("device websocket gateway is already attached");
    }
    this.#attachedServer = server;

    this.#upgradeHandler = (request, socket, head) => {
      void this.#handleUpgrade(request, socket, head, pathname);
    };
    server.on("upgrade", this.#upgradeHandler);
  }

  disconnectDevice(deviceId: string): void {
    const live = this.#live.get(deviceId);
    if (!live) {
      this.#router.disconnectDevice(deviceId);
      return;
    }
    if (this.#retire(deviceId, live, "explicit_disconnect", 4001)) {
      live.socket.close(4001, "device revoked or disconnected by relay");
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#attachedServer && this.#upgradeHandler) {
      this.#attachedServer.off("upgrade", this.#upgradeHandler);
    }
    this.#attachedServer = null;
    this.#upgradeHandler = null;

    for (const [deviceId, live] of this.#live) {
      this.#retire(deviceId, live, "gateway_shutdown");
    }
    // Include superseded sockets still completing their close handshake.
    // This gateway owns these sockets; no external client is terminated.
    for (const socket of this.#server.clients) {
      socket.terminate();
    }

    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
  }

  async #handleUpgrade(
    request: IncomingMessage,
    socket: {
      write(data: string): void;
      destroy(): void;
    },
    head: Buffer,
    pathname: string,
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    if (url.pathname !== pathname) {
      return;
    }

    const deviceId = singleHeader(
      request.headers[DEVICE_ID_HEADER],
    );
    const credential = parseDeviceAuthorization(
      request.headers.authorization,
    );
    if (!deviceId || !credential) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const accountId = await this.#registry.authenticateDevice(
      deviceId,
      credential,
    );
    if (!accountId) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    // Authentication is asynchronous. Do not accept a session after teardown.
    if (this.#closed || !this.#attachedServer) {
      socket.destroy();
      return;
    }

    this.#server.handleUpgrade(request, socket as never, head, (ws) => {
      this.#acceptSocket({
        socket: ws,
        accountId,
        deviceId,
      });
    });
  }

  #acceptSocket(input: {
    socket: WebSocket;
    accountId: string;
    deviceId: string;
  }): void {
    const previous = this.#live.get(input.deviceId);
    if (previous && this.#retire(input.deviceId, previous, "superseded", 4000)) {
      previous.socket.close(4000, "superseded by newer device connection");
    }

    const connection = this.#router.connectDevice({
      accountId: input.accountId,
      deviceId: input.deviceId,
      send: async (message: RelayToDeviceMessage) => {
        if (input.socket.readyState !== WebSocket.OPEN) {
          throw new Error("device websocket is not open");
        }
        await sendJson(input.socket, message);
      },
    });
    const live: LiveDevice = {
      socket: input.socket,
      connection,
      sessionId: randomUUID(),
      startedAt: performance.now(),
      lastPongAt: null,
      pendingPing: null,
      heartbeatTimer: null,
    };
    this.#live.set(input.deviceId, live);

    input.socket.on("message", (raw: RawData) => {
      const message = parseDeviceMessage(raw);
      if (message) connection.receive(message);
    });

    input.socket.on("pong", (payload: Buffer) => {
      if (this.#live.get(input.deviceId) !== live) return;
      if (!live.pendingPing || !live.pendingPing.equals(payload)) return;
      live.lastPongAt = performance.now();
      live.pendingPing = null;
      this.#schedulePing(input.deviceId, live);
    });

    input.socket.once("close", (code: number) => {
      this.#retire(input.deviceId, live, "peer_closed", code);
    });

    input.socket.on("error", () => {
      if (this.#retire(input.deviceId, live, "socket_error")) {
        input.socket.terminate();
      }
    });

    this.#emit(input.deviceId, live, "connected");
    this.#schedulePing(input.deviceId, live);
  }

  #schedulePing(deviceId: string, live: LiveDevice): void {
    this.#clearHeartbeat(live);
    if (this.#live.get(deviceId) !== live) return;
    live.heartbeatTimer = setTimeout(() => {
      if (this.#live.get(deviceId) !== live) return;
      if (live.socket.readyState !== WebSocket.OPEN) {
        this.#retire(deviceId, live, "heartbeat_send_failed");
        live.socket.terminate();
        return;
      }
      const nonce = randomBytes(16);
      live.pendingPing = nonce;
      live.heartbeatTimer = setTimeout(() => {
        if (
          this.#live.get(deviceId) === live &&
          live.pendingPing === nonce
        ) {
          this.#retire(deviceId, live, "heartbeat_timeout");
          live.socket.terminate();
        }
      }, this.#heartbeatTimeoutMs);
      live.heartbeatTimer.unref();

      const failed = () => {
        if (this.#retire(deviceId, live, "heartbeat_send_failed")) {
          live.socket.terminate();
        }
      };
      try {
        live.socket.ping(nonce, false, (error) => {
          if (error) failed();
        });
      } catch {
        failed();
      }
    }, this.#heartbeatIntervalMs);
    live.heartbeatTimer.unref();
  }

  #clearHeartbeat(live: LiveDevice): void {
    if (live.heartbeatTimer) {
      clearTimeout(live.heartbeatTimer);
      live.heartbeatTimer = null;
    }
  }

  #retire(
    deviceId: string,
    live: LiveDevice,
    reason: DisconnectReason,
    closeCode?: number,
  ): boolean {
    // Never let an expired timer or a late close retire a replacement socket.
    if (this.#live.get(deviceId) !== live) return false;
    this.#live.delete(deviceId);
    this.#clearHeartbeat(live);
    live.pendingPing = null;
    live.connection.disconnect();
    this.#emit(deviceId, live, "disconnected", reason, closeCode);
    return true;
  }

  #emit(
    deviceId: string,
    live: LiveDevice,
    event: DeviceConnectionEvent["event"],
    reason?: DisconnectReason,
    closeCode?: number,
  ): void {
    const now = performance.now();
    try {
      this.#onConnectionEvent({
        component: "device_websocket",
        event,
        device_id: deviceId,
        session_id: live.sessionId,
        at: new Date().toISOString(),
        session_ms: Math.round(now - live.startedAt),
        last_pong_age_ms: live.lastPongAt === null
          ? null
          : Math.round(now - live.lastPongAt),
        ...(reason === undefined ? {} : { reason }),
        ...(closeCode === undefined ? {} : { close_code: closeCode }),
      });
    } catch {
      // Logging must not interfere with connection lifecycle.
    }
  }
}

function parseDeviceMessage(
  raw: RawData,
): DeviceToRelayMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.type === "result" &&
    typeof record.routeId === "string" &&
    record.result &&
    typeof record.result === "object"
  ) {
    return value as DeviceToRelayMessage;
  }
  if (
    record.type === "device_hello" &&
    typeof record.deviceId === "string"
  ) {
    return value as DeviceToRelayMessage;
  }
  if (
    record.type === "policy_ack" &&
    typeof record.deviceId === "string" &&
    typeof record.revision === "number" &&
    typeof record.applied === "boolean"
  ) {
    return value as DeviceToRelayMessage;
  }
  if (
    record.type === "device_telemetry" &&
    typeof record.deviceId === "string"
  ) {
    return value as DeviceToRelayMessage;
  }
  return null;
}

async function sendJson(
  socket: WebSocket,
  message: RelayToDeviceMessage,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(message), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function parseDeviceAuthorization(
  header: string | undefined,
): string | null {
  if (!header) return null;
  const match = /^Device\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function singleHeader(
  value: string | string[] | undefined,
): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

function rejectUpgrade(
  socket: { write(data: string): void; destroy(): void },
  status: 401 | 404,
  reason: string,
): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}
