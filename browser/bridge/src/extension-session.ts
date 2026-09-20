import { WebSocket, WebSocketServer } from "ws";

export type ExtensionBridgeMessage = Record<string, unknown>;

export type AuthenticatedExtensionClient = {
  readonly extension_id: string;
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
  readonly #socket: WebSocket;
  readonly #messages: ExtensionBridgeMessage[] = [];
  readonly #waiters: MessageWaiter[] = [];
  #closed = false;

  constructor(extensionId: string, socket: WebSocket) {
    this.extension_id = extensionId;
    this.#socket = socket;

    socket.on("close", () => {
      this.#closed = true;
      const error = new Error("extension bridge client disconnected");
      for (const waiter of this.#waiters.splice(0)) {
        waiter.reject(error);
      }
    });
  }

  push(message: ExtensionBridgeMessage): void {
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
    const queued = this.#messages.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    if (this.#closed) {
      return Promise.reject(
        new Error("extension bridge client is disconnected"),
      );
    }
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  close(): void {
    this.#socket.close();
  }
}

export async function startExtensionBridgeServer(options: {
  launchToken: string;
}): Promise<ExtensionBridgeServer> {
  if (!options.launchToken.trim()) {
    throw new Error("extension launch token must be non-empty");
  }

  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("extension bridge did not bind a TCP address");
  }

  const clients = new Set<ExtensionClient>();
  const waiters: Array<(client: ExtensionClient) => void> = [];

  server.on("connection", (socket) => {
    let authenticatedClient: ExtensionClient | undefined;
    let authenticated = false;

    const rejectConnection = (code: number, reason: string): void => {
      if (authenticatedClient) {
        clients.delete(authenticatedClient);
      }
      socket.close(code, reason);
    };

    socket.on("message", (data) => {
      const parsed = parseMessage(String(data));
      if (!parsed) {
        rejectConnection(4002, "invalid_json");
        return;
      }

      if (!authenticated) {
        if (
          parsed.type !== "hello" ||
          parsed.token !== options.launchToken ||
          typeof parsed.extension_id !== "string" ||
          !parsed.extension_id.trim()
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
        socket.send(
          JSON.stringify({
            type: "hello_ack",
            authenticated: true,
          }),
        );

        const waiter = waiters.shift();
        if (waiter) {
          waiter(authenticatedClient);
        }
        return;
      }

      if (containsSensitiveBrowserState(parsed)) {
        rejectConnection(4003, "sensitive_data_forbidden");
        return;
      }

      authenticatedClient?.push(parsed);
    });

    socket.on("close", () => {
      if (authenticatedClient) {
        clients.delete(authenticatedClient);
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    waitForAuthenticatedClient() {
      const existing = clients.values().next().value as
        | ExtensionClient
        | undefined;
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<AuthenticatedExtensionClient>((resolve) => {
        waiters.push(resolve);
      });
    },
    authenticatedClientCount() {
      return clients.size;
    },
    async close() {
      for (const client of [...clients]) {
        client.close();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
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
