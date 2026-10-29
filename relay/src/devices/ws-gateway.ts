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

type LiveDevice = {
  socket: WebSocket;
  connection: DeviceConnectionHandle;
  awaitingPong: boolean;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

export class DeviceWebSocketGateway {
  readonly #registry: DeviceRegistry;
  readonly #router: DeviceRouter;
  readonly #server = new WebSocketServer({ noServer: true });
  readonly #live = new Map<string, LiveDevice>();
  #attachedServer: Server | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  readonly #heartbeatIntervalMs: number;
  #upgradeHandler:
    | ((request: IncomingMessage, socket: any, head: Buffer) => void)
    | null = null;

  constructor(options: {
    registry: DeviceRegistry;
    router: DeviceRouter;
    heartbeatIntervalMs?: number;
  }) {
    this.#registry = options.registry;
    this.#router = options.router;
    this.#heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#heartbeatIntervalMs) ||
        this.#heartbeatIntervalMs < 10) {
      throw new Error("device heartbeat interval must be at least 10 ms");
    }
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
    this.#heartbeatTimer = setInterval(
      () => this.#checkHeartbeats(),
      this.#heartbeatIntervalMs,
    );
    this.#heartbeatTimer.unref();
  }

  disconnectDevice(deviceId: string): void {
    const live = this.#live.get(deviceId);
    if (!live) {
      this.#router.disconnectDevice(deviceId);
      return;
    }
    this.#live.delete(deviceId);
    live.connection.disconnect();
    live.socket.close(4001, "device revoked or disconnected by relay");
  }

  async close(): Promise<void> {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
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

  // Registration is not liveness. Poll only authenticated sockets, and
  // disconnect the old router generation when its reader stops answering
  // WebSocket Ping. Never cancel, resend or replay an uncertain mutation.
  #checkHeartbeats(): void {
    for (const [deviceId, live] of this.#live) {
      if (live.socket.readyState !== WebSocket.OPEN || live.awaitingPong) {
        this.#evictUnresponsiveSocket(deviceId, live);
        continue;
      }
      live.awaitingPong = true;
      try {
        live.socket.ping();
      } catch {
        this.#evictUnresponsiveSocket(deviceId, live);
      }
    }
  }

  #evictUnresponsiveSocket(deviceId: string, live: LiveDevice): void {
    if (this.#live.get(deviceId)?.socket !== live.socket) return;
    this.#live.delete(deviceId);
    live.connection.disconnect();
    // terminate, rather than waiting indefinitely for a close handshake
    // from the socket whose WebSocket reader is no longer responsive.
    live.socket.terminate();
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
    this.#live.set(input.deviceId, {
      socket: input.socket,
      connection,
      awaitingPong: false,
    });

    input.socket.on("pong", () => {
      const current = this.#live.get(input.deviceId);
      if (current?.socket === input.socket) current.awaitingPong = false;
    });

    input.socket.on("message", (raw: RawData) => {
      const message = parseDeviceMessage(raw);
      if (message) connection.receive(message);
    });

    input.socket.once("close", () => {
      const current = this.#live.get(input.deviceId);
      if (current?.socket !== input.socket) return;
      this.#live.delete(input.deviceId);
      connection.disconnect();
    });

    input.socket.once("error", () => {
      const current = this.#live.get(input.deviceId);
      if (current?.socket !== input.socket) return;
      this.#live.delete(input.deviceId);
      connection.disconnect();
    });
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
