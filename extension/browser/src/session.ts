export type ExtensionBridgeOutboundMessage =
  Record<string, unknown>;

export type ExtensionSocket = {
  readonly readyState: number;

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void;

  send(data: string): void;
  close(): void;
};

export type ExtensionSocketFactory = {
  create(url: string): ExtensionSocket;
};

export class ExtensionSessionError extends Error {
  readonly code:
    | "authentication_failed"
    | "disconnected"
    | "sensitive_data_forbidden";

  constructor(
    code:
      | "authentication_failed"
      | "disconnected"
      | "sensitive_data_forbidden",
    message: string,
  ) {
    super(message);
    this.name = "ExtensionSessionError";
    this.code = code;
  }
}

type HeartbeatScheduler = (
  callback: () => void,
  intervalMs: number,
) => unknown;

type HeartbeatCanceller = (
  handle: unknown,
) => void;

export class ExtensionBridgeClient {
  readonly #url: string;
  readonly #launchToken: string;
  readonly #extensionId: string;
  readonly #socketFactory: ExtensionSocketFactory;
  readonly #scheduleHeartbeat: HeartbeatScheduler;
  readonly #cancelHeartbeat: HeartbeatCanceller;

  #socket: ExtensionSocket | null = null;
  #authenticated = false;
  #connecting: Promise<void> | null = null;
  #heartbeatHandle: unknown = null;

  readonly #messages:
    ExtensionBridgeOutboundMessage[] = [];

  readonly #messageWaiters: Array<{
    resolve(
      message: ExtensionBridgeOutboundMessage,
    ): void;

    reject(error: ExtensionSessionError): void;
  }> = [];

  constructor(options: {
    url: string;
    launchToken: string;
    extensionId: string;
    socketFactory?: ExtensionSocketFactory;

    scheduleHeartbeat?: HeartbeatScheduler;
    cancelHeartbeat?: HeartbeatCanceller;
  }) {
    if (!options.url.trim()) {
      throw new Error(
        "bridge URL is required",
      );
    }

    if (!options.launchToken.trim()) {
      throw new Error(
        "launch token is required",
      );
    }

    if (!options.extensionId.trim()) {
      throw new Error(
        "extension ID is required",
      );
    }

    this.#url = options.url;
    this.#launchToken =
      options.launchToken;
    this.#extensionId =
      options.extensionId;

    this.#socketFactory =
      options.socketFactory ??
      new BrowserWebSocketFactory();

    this.#scheduleHeartbeat =
      options.scheduleHeartbeat ??
      ((callback, intervalMs) => {
        const handle = globalThis.setInterval(
          callback,
          intervalMs,
        );
        if (
          typeof handle === "object" &&
          handle !== null &&
          "unref" in handle &&
          typeof (handle as { unref?: () => void }).unref ===
            "function"
        ) {
          (handle as { unref: () => void }).unref();
        }
        return handle;
      });

    this.#cancelHeartbeat =
      options.cancelHeartbeat ??
      ((handle) => {
        globalThis.clearInterval(
          handle as number,
        );
      });
  }

  get authenticated(): boolean {
    return this.#authenticated;
  }

  connect(): Promise<void> {
    if (this.#authenticated) {
      return Promise.resolve();
    }

    if (this.#connecting) {
      return this.#connecting;
    }

    const socket =
      this.#socketFactory.create(
        this.#url,
      );

    this.#socket = socket;

    this.#connecting =
      new Promise<void>(
        (resolve, reject) => {
          let settled = false;

          const fail = (
            error:
              ExtensionSessionError,
          ) => {
            this.#stopHeartbeat();

            this.#authenticated =
              false;

            this.#connecting = null;

            if (!settled) {
              settled = true;
              reject(error);
            }
          };

          socket.addEventListener(
            "open",
            () => {
              socket.send(
                JSON.stringify({
                  type: "hello",
                  token:
                    this.#launchToken,
                  extension_id:
                    this.#extensionId,
                }),
              );
            },
          );

          socket.addEventListener(
            "message",
            (event) => {
              const parsed =
                parseSocketMessage(
                  event,
                );

              if (!settled) {
                if (
                  parsed?.type ===
                    "hello_ack" &&
                  parsed.authenticated ===
                    true
                ) {
                  settled = true;

                  this.#authenticated =
                    true;

                  this.#connecting =
                    null;

                  this.#startHeartbeat();

                  resolve();
                  return;
                }

                fail(
                  new ExtensionSessionError(
                    "authentication_failed",
                    "bridge did not acknowledge extension authentication",
                  ),
                );

                return;
              }

              if (
                !this.#authenticated ||
                parsed === null
              ) {
                return;
              }

              if (
                containsSensitiveBrowserState(
                  parsed,
                )
              ) {
                this.close();

                this.#rejectMessageWaiters(
                  new ExtensionSessionError(
                    "sensitive_data_forbidden",
                    "bridge sent forbidden browser credential state",
                  ),
                );

                return;
              }

              this.#enqueueMessage(
                parsed,
              );
            },
          );

          socket.addEventListener(
            "close",
            () => {
              this.#stopHeartbeat();

              this.#authenticated =
                false;

              this.#socket = null;
              this.#connecting = null;

              const error =
                new ExtensionSessionError(
                  "disconnected",
                  "extension bridge socket closed",
                );

              this.#rejectMessageWaiters(
                error,
              );

              if (!settled) {
                settled = true;

                reject(
                  new ExtensionSessionError(
                    "disconnected",
                    "bridge closed before authentication completed",
                  ),
                );
              }
            },
          );

          socket.addEventListener(
            "error",
            () => {
              fail(
                new ExtensionSessionError(
                  "disconnected",
                  "bridge socket failed",
                ),
              );
            },
          );
        },
      );

    return this.#connecting;
  }

  nextMessage():
    Promise<ExtensionBridgeOutboundMessage> {
    const queued =
      this.#messages.shift();

    if (queued) {
      return Promise.resolve(
        queued,
      );
    }

    if (!this.#authenticated) {
      return Promise.reject(
        new ExtensionSessionError(
          "disconnected",
          "extension bridge session is not authenticated",
        ),
      );
    }

    return new Promise(
      (resolve, reject) => {
        this.#messageWaiters.push({
          resolve,
          reject,
        });
      },
    );
  }

  send(
    message:
      ExtensionBridgeOutboundMessage,
  ): void {
    if (
      containsSensitiveBrowserState(
        message,
      )
    ) {
      throw new ExtensionSessionError(
        "sensitive_data_forbidden",
        "browser credentials and authentication state must not cross the extension bridge",
      );
    }

    if (
      !this.#authenticated ||
      this.#socket === null ||
      this.#socket.readyState !== 1
    ) {
      throw new ExtensionSessionError(
        "disconnected",
        "extension bridge session is not authenticated",
      );
    }

    this.#socket.send(
      JSON.stringify(message),
    );
  }

  close(): void {
    this.#stopHeartbeat();

    this.#authenticated = false;
    this.#connecting = null;

    this.#socket?.close();
    this.#socket = null;

    this.#rejectMessageWaiters(
      new ExtensionSessionError(
        "disconnected",
        "extension bridge session closed",
      ),
    );
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();

    this.#heartbeatHandle =
      this.#scheduleHeartbeat(
        () => {
          if (
            !this.#authenticated ||
            this.#socket === null ||
            this.#socket.readyState !== 1
          ) {
            return;
          }

          this.#socket.send(
            JSON.stringify({
              type: "keepalive",
            }),
          );
        },
        20_000,
      );
  }

  #stopHeartbeat(): void {
    if (
      this.#heartbeatHandle === null
    ) {
      return;
    }

    this.#cancelHeartbeat(
      this.#heartbeatHandle,
    );

    this.#heartbeatHandle = null;
  }

  #enqueueMessage(
    message:
      ExtensionBridgeOutboundMessage,
  ): void {
    const waiter =
      this.#messageWaiters.shift();

    if (waiter) {
      waiter.resolve(message);
      return;
    }

    this.#messages.push(message);
  }

  #rejectMessageWaiters(
    error: ExtensionSessionError,
  ): void {
    for (
      const waiter of
      this.#messageWaiters.splice(0)
    ) {
      waiter.reject(error);
    }
  }
}

class BrowserWebSocketFactory
  implements ExtensionSocketFactory
{
  create(
    url: string,
  ): ExtensionSocket {
    return new WebSocket(url);
  }
}

function parseSocketMessage(
  event: unknown,
): Record<string, unknown> | null {
  if (
    typeof event !== "object" ||
    event === null ||
    !("data" in event)
  ) {
    return null;
  }

  const data =
    (event as {
      data: unknown;
    }).data;

  if (typeof data !== "string") {
    return null;
  }

  try {
    const parsed =
      JSON.parse(data) as unknown;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as
        Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

const SENSITIVE_BROWSER_KEYS =
  new Set([
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

function containsSensitiveBrowserState(
  value: unknown,
): boolean {
  if (Array.isArray(value)) {
    return value.some(
      containsSensitiveBrowserState,
    );
  }

  if (
    typeof value !== "object" ||
    value === null
  ) {
    return false;
  }

  for (
    const [key, nested] of
    Object.entries(value)
  ) {
    if (
      SENSITIVE_BROWSER_KEYS.has(
        key.toLowerCase(),
      )
    ) {
      return true;
    }

    if (
      containsSensitiveBrowserState(
        nested,
      )
    ) {
      return true;
    }
  }

  return false;
}