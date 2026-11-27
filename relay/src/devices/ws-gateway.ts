import { randomUUID } from "node:crypto";
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

// S2 heartbeat bounds (normative in docs/CONNECTION_STATE_MACHINE.md):
// a socket whose Pongs stop echoing the challenged nonce is retired
// well within the 60 s stale bound.
export const RELAY_HEARTBEAT_INTERVAL_MS = 15_000;
export const RELAY_STALE_AFTER_MS = 45_000;
const RELAY_STALE_LIMIT_MS = 60_000;

export type RelayHeartbeatOptions = {
  intervalMs?: number;
  staleMs?: number;
};

type HeartbeatState = {
  timer: NodeJS.Timeout | null;
  outstanding: string | null;
  previous: string | null;
  lastPongAt: number;
};

type LiveDevice = {
  socket: WebSocket;
  connection: DeviceConnectionHandle;
  heartbeat: HeartbeatState;
};

export class DeviceWebSocketGateway {
  readonly #registry: DeviceRegistry;
  readonly #router: DeviceRouter;
  readonly #heartbeatIntervalMs: number;
  readonly #staleAfterMs: number;
  readonly #server = new WebSocketServer({ noServer: true });
  readonly #live = new Map<string, LiveDevice>();
  #attachedServer: Server | null = null;
  #upgradeHandler:
    | ((request: IncomingMessage, socket: any, head: Buffer) => void)
    | null = null;

  constructor(options: {
    registry: DeviceRegistry;
    router: DeviceRouter;
    heartbeat?: RelayHeartbeatOptions;
  }) {
    this.#registry = options.registry;
    this.#router = options.router;
    const intervalMs =
      options.heartbeat?.intervalMs ?? RELAY_HEARTBEAT_INTERVAL_MS;
    const staleMs = options.heartbeat?.staleMs ?? RELAY_STALE_AFTER_MS;
    if (
      !Number.isFinite(intervalMs) ||
      !Number.isFinite(staleMs) ||
      intervalMs <= 0 ||
      staleMs <= 0 ||
      intervalMs > staleMs ||
      staleMs > RELAY_STALE_LIMIT_MS
    ) {
      throw new RangeError(
        "relay heartbeat requires 0 < interval <= stale <= 60000 ms",
      );
    }
    this.#heartbeatIntervalMs = intervalMs;
    this.#staleAfterMs = staleMs;
  }

  attach(server: Server, pathname = "/device"): void {
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
    this.#live.delete(deviceId);
    stopHeartbeat(live.heartbeat);
    live.connection.disconnect();
    live.socket.close(4001, "device revoked or disconnected by relay");
  }

  async close(): Promise<void> {
    if (this.#attachedServer && this.#upgradeHandler) {
      this.#attachedServer.off("upgrade", this.#upgradeHandler);
    }
    this.#attachedServer = null;
    this.#upgradeHandler = null;

    for (const deviceId of [...this.#live.keys()]) {
      this.disconnectDevice(deviceId);
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
    if (previous) {
      this.#live.delete(input.deviceId);
      stopHeartbeat(previous.heartbeat);
      previous.connection.disconnect();
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
    const heartbeat: HeartbeatState = {
      timer: null,
      outstanding: null,
      previous: null,
      lastPongAt: Date.now(),
    };
    this.#live.set(input.deviceId, {
      socket: input.socket,
      connection,
      heartbeat,
    });

    input.socket.on("message", (raw: RawData) => {
      const message = parseDeviceMessage(raw);
      if (message) connection.receive(message);
    });

    input.socket.on("pong", (data: RawData) => {
      const current = this.#live.get(input.deviceId);
      if (current?.socket !== input.socket) return;
      // A Pong answering the live challenge, or the previous one late,
      // proves liveness. A stray Pong with no live challenge is
      // ignored — never a retire. Only a wrong echo to a live
      // challenge retires, and rotation expires old nonces so a peer
      // stuck replaying one still retires at the next challenge.
      const echo = data.toString();
      const heartbeat = current.heartbeat;
      if (heartbeat.outstanding !== null && echo === heartbeat.outstanding) {
        heartbeat.outstanding = null;
        heartbeat.lastPongAt = Date.now();
      } else if (
        heartbeat.previous !== null &&
        echo === heartbeat.previous
      ) {
        heartbeat.lastPongAt = Date.now();
      } else if (heartbeat.outstanding === null) {
        // Nothing challenged: duplicate or unsolicited frame, ignore.
      } else {
        this.#retireStaleSocket(input.deviceId, input.socket);
      }
    });

    input.socket.once("close", () => {
      const current = this.#live.get(input.deviceId);
      if (current?.socket !== input.socket) return;
      this.#live.delete(input.deviceId);
      stopHeartbeat(current.heartbeat);
      connection.disconnect();
    });

    input.socket.once("error", () => {
      const current = this.#live.get(input.deviceId);
      if (current?.socket !== input.socket) return;
      this.#live.delete(input.deviceId);
      stopHeartbeat(current.heartbeat);
      connection.disconnect();
    });

    this.#scheduleHeartbeat(input.deviceId, input.socket, heartbeat);
  }

  #scheduleHeartbeat(
    deviceId: string,
    socket: WebSocket,
    heartbeat: HeartbeatState,
  ): void {
    heartbeat.timer = setTimeout(() => {
      heartbeat.timer = null;
      this.#heartbeatTick(deviceId, socket, heartbeat);
    }, this.#heartbeatIntervalMs);
  }

  #heartbeatTick(
    deviceId: string,
    socket: WebSocket,
    heartbeat: HeartbeatState,
  ): void {
    const current = this.#live.get(deviceId);
    if (current?.socket !== socket || current.heartbeat !== heartbeat) return;
    if (Date.now() - heartbeat.lastPongAt >= this.#staleAfterMs) {
      this.#retireStaleSocket(deviceId, socket);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      this.#retireStaleSocket(deviceId, socket);
      return;
    }
    const nonce = randomUUID();
    heartbeat.previous = heartbeat.outstanding;
    heartbeat.outstanding = nonce;
    this.#scheduleHeartbeat(deviceId, socket, heartbeat);
    try {
      socket.ping(nonce, undefined, (error) => {
        if (error) {
          this.#retireStaleSocket(deviceId, socket);
        }
      });
    } catch {
      this.#retireStaleSocket(deviceId, socket);
    }
  }

  /**
   * Retire a stale socket: generation-guarded terminate. Only the current
   * socket for the device is ever touched, so a superseded socket's timers
   * and handlers can never retire the live replacement. In-flight work of
   * the retired generation settles as `disconnected` via the router; the
   * peer reconnects as a new generation and nothing is replayed.
   */
  #retireStaleSocket(deviceId: string, socket: WebSocket): void {
    const current = this.#live.get(deviceId);
    if (current?.socket !== socket) return;
    this.#live.delete(deviceId);
    stopHeartbeat(current.heartbeat);
    current.connection.disconnect();
    try {
      socket.terminate();
    } catch {
      // Already dead; presence and pending work are settled above.
    }
  }
}

function stopHeartbeat(heartbeat: HeartbeatState): void {
  if (heartbeat.timer) {
    clearTimeout(heartbeat.timer);
    heartbeat.timer = null;
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
    record.type !== "result" ||
    typeof record.routeId !== "string" ||
    !record.result ||
    typeof record.result !== "object"
  ) {
    return null;
  }
  return value as DeviceToRelayMessage;
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
