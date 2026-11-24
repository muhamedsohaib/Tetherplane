import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

export type ExtensionBridgeMessage = Record<string, unknown>;

// The browser sends an application keepalive every 20 seconds. Allow
// several missed intervals, including normal service-worker scheduling jitter.
const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

function deadlineMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error("extension session deadline must be a positive timer value");
  }
  return value;
}

export type ExtensionIdResolver =
  | string
  | (() => string | null | undefined | Promise<string | null | undefined>);

export type AuthenticatedExtensionClient = {
  readonly extension_id: string;
  readonly closed: Promise<void>;
  send(message: ExtensionBridgeMessage): void;
  nextMessage(): Promise<ExtensionBridgeMessage>;
  close(): void;
};

export type ExtensionBridgeServer = {
  readonly url: string;
  waitForAuthenticatedClient(): Promise<AuthenticatedExtensionClient>;
  authenticatedClientCount(): number;
  close(): Promise<void>;
};

type MessageWaiter = {
  resolve(message: ExtensionBridgeMessage): void;
  reject(error: Error): void;
};

class ExtensionClient implements AuthenticatedExtensionClient {
  readonly extension_id: string;
  readonly closed: Promise<void>;
  readonly #socket: WebSocket;
  readonly #messages: ExtensionBridgeMessage[] = [];
  readonly #waiters: MessageWaiter[] = [];
  #closed = false;

  constructor(extensionId: string, socket: WebSocket) {
    this.extension_id = extensionId;
    this.#socket = socket;
    this.closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });

    socket.on("close", () => {
      this.#closed = true;
      this.#messages.length = 0;
      const error = new Error("extension bridge client disconnected");
      for (const waiter of this.#waiters.splice(0)) {
        waiter.reject(error);
      }
    });
  }

  push(message: ExtensionBridgeMessage): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve(message);
      return;
    }
    this.#messages.push(message);
  }

  send(message: ExtensionBridgeMessage): void {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("extension bridge client is disconnected");
    }
    this.#socket.send(JSON.stringify(message));
  }

  nextMessage(): Promise<ExtensionBridgeMessage> {
    if (this.#closed) {
      return Promise.reject(
        new Error("extension bridge client is disconnected"),
      );
    }
    const queued = this.#messages.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  close(): void {
    // Retire only this authenticated bridge socket. Do not close browser tabs.
    this.#socket.terminate();
  }
}

export async function startExtensionBridgeServer(options: {
  launchToken: string;
  port?: number;
  expectedExtensionId?: ExtensionIdResolver;
  authTimeoutMs?: number;
  idleTimeoutMs?: number;
}): Promise<ExtensionBridgeServer> {
  const authTimeoutMs = deadlineMs(options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
  const idleTimeoutMs = deadlineMs(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  if (!options.launchToken.trim()) {
    throw new Error("extension launch token must be non-empty");
  }
  if (typeof options.expectedExtensionId === "string") {
    validateExtensionId(options.expectedExtensionId);
  }

  const httpServer = http.createServer((_req, response) => {
    response.statusCode = 404;
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const verifiedOrigins = new WeakMap<WebSocket, string>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  httpServer.on("upgrade", (request, socket, head) => {
    void (async () => {
      const origin =
        typeof request.headers.origin === "string"
          ? request.headers.origin
          : "";
      const originExtensionId = extensionIdFromOrigin(origin);
      if (!originExtensionId) {
        rejectHttpUpgrade(socket, 403, "Forbidden");
        return;
      }

      if (options.expectedExtensionId !== undefined) {
        const pinned =
          typeof options.expectedExtensionId === "function"
            ? await options.expectedExtensionId()
            : options.expectedExtensionId;
        if (pinned !== undefined && pinned !== null) {
          if (
            !isValidExtensionId(pinned) ||
            originExtensionId !== pinned
          ) {
            rejectHttpUpgrade(socket, 403, "Forbidden");
            return;
          }
        }
      }

      if (socket.destroyed || closing) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        verifiedOrigins.set(ws, originExtensionId);
        wss.emit("connection", ws, request);
      });
    })().catch(() => {
      rejectHttpUpgrade(socket, 500, "Internal Server Error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    httpServer.close();
    throw new Error("extension bridge did not bind a TCP address");
  }

  const clients = new Set<ExtensionClient>();
  const waiters: Array<{
    resolve(client: ExtensionClient): void;
    reject(error: Error): void;
  }> = [];

  wss.on("connection", (socket) => {
    const originExtensionId = verifiedOrigins.get(socket);
    let authenticatedClient: ExtensionClient | undefined;
    let authenticated = false;
    let retired = false;
    let timer: NodeJS.Timeout | undefined;

    const clearDeadline = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const retire = (): void => {
      retired = true;
      clearDeadline();
      if (authenticatedClient) clients.delete(authenticatedClient);
    };
    const armDeadline = (durationMs: number): void => {
      clearDeadline();
      timer = setTimeout(() => {
        retire();
        socket.terminate();
      }, durationMs);
      timer.unref();
    };
    armDeadline(authTimeoutMs);
    socket.on("error", () => {
      retire();
      socket.terminate();
    });

    const rejectConnection = (code: number, reason: string): void => {
      retire();
      socket.close(code, reason);
    };

    socket.on("message", (data) => {
      if (retired || closing) return;
      const parsed = parseMessage(String(data));
      if (!parsed) {
        rejectConnection(4002, "invalid_json");
        return;
      }

      if (!authenticated) {
        if (
          parsed.type !== "hello" ||
          typeof parsed.token !== "string" ||
          !constantTimeTokenEqual(parsed.token, options.launchToken) ||
          typeof parsed.extension_id !== "string" ||
          !originExtensionId ||
          parsed.extension_id !== originExtensionId
        ) {
          rejectConnection(4001, "unauthorized");
          return;
        }

        authenticated = true;
        authenticatedClient = new ExtensionClient(
          parsed.extension_id,
          socket,
        );
        clients.add(authenticatedClient);
        armDeadline(idleTimeoutMs);
        socket.send(
          JSON.stringify({
            type: "hello_ack",
            authenticated: true,
          }),
        );

        const waiter = waiters.shift();
        if (waiter) {
          waiter.resolve(authenticatedClient);
        }
        return;
      }

      if (containsSensitiveBrowserState(parsed)) {
        rejectConnection(4003, "sensitive_data_forbidden");
        return;
      }

      // An open TCP socket alone is not proof that the extension worker
      // is alive. Only valid authenticated application traffic renews it.
      if (parsed.type === "keepalive" || parsed.type === "event" || parsed.type === "result") {
        armDeadline(idleTimeoutMs);
      }
      if (parsed.type === "keepalive") return;

      authenticatedClient?.push(parsed);
    });

    socket.on("close", retire);
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    waitForAuthenticatedClient() {
      if (closing) return Promise.reject(new Error("extension bridge server is closed"));
      const existing = clients.values().next().value as
        | ExtensionClient
        | undefined;
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<AuthenticatedExtensionClient>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    authenticatedClientCount() {
      return clients.size;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error("extension bridge server is closed"));
      }
      closePromise = (async () => {
        // Include unauthenticated and half-open sessions, not just clients
        // that completed hello. Shutdown must not wait for their consent.
        for (const socket of wss.clients) socket.terminate();
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
        if (!httpServer.listening) return;
        httpServer.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => error ? reject(error) : resolve());
        });
      })();
      return closePromise;
    },
  };
}

function rejectHttpUpgrade(
  socket: import("node:stream").Duplex,
  statusCode: number,
  statusText: string,
): void {
  if (!socket.destroyed && socket.writable) {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`,
    );
  }
  socket.destroy();
}

function extensionIdFromOrigin(origin: string): string | null {
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  return match?.[1] ?? null;
}

function isValidExtensionId(value: string): boolean {
  return /^[a-p]{32}$/.test(value);
}

function validateExtensionId(value: string): string {
  if (!isValidExtensionId(value)) {
    throw new Error("extension ID is invalid");
  }
  return value;
}

function constantTimeTokenEqual(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function parseMessage(text: string): ExtensionBridgeMessage | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as ExtensionBridgeMessage;
    }
  } catch {
    // Invalid JSON is rejected by the caller.
  }
  return null;
}

const SENSITIVE_BROWSER_KEYS = new Set([
  "authorization",
  "authorization_header",
  "cookie",
  "cookies",
  "set-cookie",
  "password",
  "passwords",
  "saved_password",
  "saved_passwords",
  "access_token",
  "refresh_token",
]);

function containsSensitiveBrowserState(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveBrowserState);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_BROWSER_KEYS.has(key.toLowerCase())) {
      return true;
    }
    if (containsSensitiveBrowserState(nested)) {
      return true;
    }
  }
  return false;
}
