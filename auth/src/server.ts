import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
} from "node:https";
import type { AddressInfo } from "node:net";

import type {
  TetherAuthInteractionController,
} from "./interaction.ts";

export type TetherAuthProviderHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

export type TetherAuthTlsOptions = {
  cert: string | Buffer;
  key: string | Buffer;
};

export type TetherAuthServerInteractions =
  Pick<
    TetherAuthInteractionController,
    "beginLogin" | "completeLogin"
  > &
  Partial<
    Pick<
      TetherAuthInteractionController,
      "beginInteraction" | "completeConsent"
    >
  >;

export type TetherAuthServerOptions = {
  providerHandler: TetherAuthProviderHandler;
  interactions?: TetherAuthServerInteractions;
  tls?: TetherAuthTlsOptions;
  allowInsecureLocalhost?: boolean;
};

export type TetherAuthListenOptions = {
  host: string;
  port: number;
};

export type TetherAuthAddress = {
  url: string;
};

export class TetherAuthServer {
  readonly #providerHandler: TetherAuthProviderHandler;
  readonly #interactions:
    | TetherAuthServerInteractions
    | undefined;
  readonly #tls: TetherAuthTlsOptions | undefined;
  readonly #allowInsecureLocalhost: boolean;
  #server: HttpServer | null = null;

  constructor(options: TetherAuthServerOptions) {
    if (typeof options.providerHandler !== "function") {
      throw new Error(
        "tether-auth requires an OIDC provider handler",
      );
    }
    this.#providerHandler = options.providerHandler;
    this.#interactions = options.interactions;
    this.#tls = options.tls;
    this.#allowInsecureLocalhost =
      options.allowInsecureLocalhost ?? false;
  }

  async listen(
    options: TetherAuthListenOptions,
  ): Promise<TetherAuthAddress> {
    if (this.#server) {
      throw new Error(
        "tether-auth server is already started",
      );
    }
    validateListenOptions(
      options,
      Boolean(this.#tls),
      this.#allowInsecureLocalhost,
    );

    const handler = (
      request: IncomingMessage,
      response: ServerResponse,
    ) => {
      void this.#handleRequest(request, response);
    };

    const server = this.#tls
      ? createHttpsServer(this.#tls, handler)
      : createHttpServer(handler);
    this.#server = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port, options.host);
      });
    } catch (error) {
      this.#server = null;
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error(
        "tether-auth server did not expose a TCP address",
      );
    }

    return {
      url: formatAddress(
        address,
        Boolean(this.#tls),
      ),
    };
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server || !server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const pathname = safePathname(request.url);

    if (
      request.method === "GET" &&
      pathname === "/healthz"
    ) {
      writeJson(response, 200, {
        status: "ok",
      });
      return;
    }
    if (
      request.method === "GET" &&
      pathname === "/readyz"
    ) {
      writeJson(response, 200, {
        status: "ready",
      });
      return;
    }

    if (this.#interactions) {
      const loginMatch =
        /^\/interaction\/([A-Za-z0-9._~-]{8,256})$/.exec(
          pathname,
        );
      if (
        request.method === "GET" &&
        loginMatch?.[1]
      ) {
        try {
          const pending =
            this.#interactions.beginInteraction
              ? await this.#interactions.beginInteraction(
                  request,
                  response,
                  loginMatch[1],
                )
              : {
                  kind: "login" as const,
                  ...(await this.#interactions.beginLogin(
                    request,
                    response,
                    loginMatch[1],
                  )),
                };

          if (!response.writableEnded) {
            writeJson(
              response,
              200,
              pending.kind === "consent"
                ? {
                    status: "awaiting_consent",
                    clientId: pending.clientId,
                    oidcScopes: pending.oidcScopes,
                    resourceScopes:
                      pending.resourceScopes,
                  }
                : {
                    status:
                      "pending_device_approval",
                    userCode: pending.userCode,
                    expiresAt: pending.expiresAt,
                  },
            );
          }
        } catch {
          if (!response.headersSent) {
            writeJson(response, 400, {
              error: {
                code: "invalid_interaction",
              },
            });
          } else if (!response.writableEnded) {
            response.end();
          }
        }
        return;
      }

      const consentMatch =
        /^\/interaction\/([A-Za-z0-9._~-]{8,256})\/consent$/.exec(
          pathname,
        );
      if (
        request.method === "POST" &&
        consentMatch?.[1]
      ) {
        try {
          if (!this.#interactions.completeConsent) {
            throw new Error(
              "consent interaction is not supported",
            );
          }
          await this.#interactions.completeConsent(
            request,
            response,
            consentMatch[1],
          );
          if (
            !response.headersSent &&
            !response.writableEnded
          ) {
            response.statusCode = 204;
            response.end();
          }
        } catch {
          if (!response.headersSent) {
            writeJson(response, 400, {
              error: {
                code: "invalid_interaction",
              },
            });
          } else if (!response.writableEnded) {
            response.end();
          }
        }
        return;
      }

      const completeMatch =
        /^\/interaction\/([A-Za-z0-9._~-]{8,256})\/device-login$/.exec(
          pathname,
        );
      if (
        request.method === "POST" &&
        completeMatch?.[1]
      ) {
        try {
          const body = await readObjectBody(
            request,
          );
          const userCode = stringField(
            body,
            "userCode",
          );
          validateUserCode(userCode);

          const result =
            await this.#interactions.completeLogin(
              request,
              response,
              {
                interactionUid:
                  completeMatch[1],
                userCode,
              },
            );

          if (result === "pending") {
            if (!response.writableEnded) {
              writeJson(response, 202, {
                status:
                  "pending_device_approval",
              });
            }
            return;
          }

          if (
            !response.headersSent &&
            !response.writableEnded
          ) {
            response.statusCode = 204;
            response.end();
          }
        } catch {
          if (!response.headersSent) {
            writeJson(response, 400, {
              error: {
                code: "invalid_interaction",
              },
            });
          } else if (!response.writableEnded) {
            response.end();
          }
        }
        return;
      }
    }

    this.#providerHandler(
      request,
      response,
    );
  }
}

function validateListenOptions(
  options: TetherAuthListenOptions,
  secure: boolean,
  allowInsecureLocalhost: boolean,
): void {
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65_535
  ) {
    throw new Error(
      "tether-auth port must be an integer between 0 and 65535",
    );
  }
  if (!options.host.trim()) {
    throw new Error(
      "tether-auth host must be non-empty",
    );
  }

  if (secure) {
    return;
  }
  if (!allowInsecureLocalhost) {
    throw new Error(
      "TLS is required unless insecure localhost mode is explicitly enabled",
    );
  }
  if (!isLoopbackHost(options.host)) {
    throw new Error(
      "plaintext tether-auth binding is restricted to loopback",
    );
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

function safePathname(
  rawUrl: string | undefined,
): string {
  try {
    return new URL(
      rawUrl ?? "/",
      "http://localhost",
    ).pathname;
  } catch {
    return "/";
  }
}

async function readObjectBody(
  request: IncomingMessage,
  maxBytes = 16 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new Error(
        "interaction request body exceeds size limit",
      );
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const parsed = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "interaction request body must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

function stringField(
  body: Record<string, unknown>,
  name: string,
): string {
  const value = body[name];
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(
      `${name} must be a non-empty string`,
    );
  }
  return value.trim();
}

function validateUserCode(
  value: string,
): void {
  if (
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(
      value,
    )
  ) {
    throw new Error(
      "device-login code is invalid",
    );
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader(
    "content-type",
    "application/json",
  );
  response.setHeader(
    "cache-control",
    "no-store",
  );
  response.setHeader(
    "content-length",
    Buffer.byteLength(body),
  );
  response.end(body);
}

function formatAddress(
  address: AddressInfo,
  secure: boolean,
): string {
  const protocol = secure
    ? "https"
    : "http";
  const host =
    address.family === "IPv6"
      ? `[${address.address}]`
      : address.address;
  return `${protocol}://${host}:${address.port}`;
}
