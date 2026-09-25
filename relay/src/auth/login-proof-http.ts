import {
  timingSafeEqual,
} from "node:crypto";
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

import type {
  DeviceRegistry,
} from "../devices/registry.ts";
import type {
  AuthLoginProofRegistry,
} from "./login-proof-registry.ts";

const DEVICE_ID_HEADER = "x-tetherplane-device-id";

export class AuthLoginProofHttpGateway {
  readonly #devices: DeviceRegistry;
  readonly #proofs: AuthLoginProofRegistry;
  readonly #bridgeToken: Buffer;
  #attachedServer: Server | null = null;
  #requestHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | null = null;

  constructor(options: {
    devices: DeviceRegistry;
    proofs: AuthLoginProofRegistry;
    bridgeToken: string;
  }) {
    if (
      typeof options.bridgeToken !== "string" ||
      options.bridgeToken.length < 32 ||
      /[\r\n]/.test(options.bridgeToken)
    ) {
      throw new Error(
        "auth login bridge token must contain at least 32 safe characters",
      );
    }
    this.#devices = options.devices;
    this.#proofs = options.proofs;
    this.#bridgeToken = Buffer.from(
      options.bridgeToken,
      "utf8",
    );
  }

  attach(server: Server): void {
    if (this.#attachedServer) {
      throw new Error(
        "auth login proof gateway is already attached",
      );
    }
    this.#attachedServer = server;
    this.#requestHandler = (request, response) => {
      void this.#handleRequest(request, response);
    };
    server.on("request", this.#requestHandler);
  }

  close(): void {
    if (
      this.#attachedServer &&
      this.#requestHandler
    ) {
      this.#attachedServer.off(
        "request",
        this.#requestHandler,
      );
    }
    this.#attachedServer = null;
    this.#requestHandler = null;
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    try {
      if (
        request.method === "POST" &&
        url.pathname === "/auth/device-login/start"
      ) {
        if (!this.#requireBridge(request, response)) {
          return;
        }
        const body = await readObjectBody(request);
        const interactionUid = stringField(
          body,
          "interactionUid",
        );
        writeJson(
          response,
          200,
          this.#proofs.start({ interactionUid }),
        );
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/auth/device-login/approve"
      ) {
        const accountId =
          await this.#requireDevice(
            request,
            response,
          );
        if (!accountId) {
          return;
        }
        const body = await readObjectBody(request);
        const interactionUid = stringField(
          body,
          "interactionUid",
        );
        const userCode = stringField(
          body,
          "userCode",
        );
        this.#proofs.approve({
          interactionUid,
          userCode,
          accountId,
        });
        writeJson(response, 200, {
          status: "approved",
        });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/auth/device-login/consume"
      ) {
        if (!this.#requireBridge(request, response)) {
          return;
        }
        const body = await readObjectBody(request);
        const interactionUid = stringField(
          body,
          "interactionUid",
        );
        const userCode = stringField(
          body,
          "userCode",
        );
        const proof = this.#proofs.consume({
          interactionUid,
          userCode,
        });
        if (!proof) {
          writeJson(response, 404, {
            error: {
              code: "not_found",
              message:
                "auth login proof is unavailable",
            },
          });
          return;
        }
        writeJson(response, 200, proof);
      }
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) {
          response.end();
        }
        return;
      }
      writeJson(response, 400, {
        error: {
          code: "invalid_arguments",
          message:
            error instanceof Error
              ? error.message
              : "invalid auth login proof request",
        },
      });
    }
  }

  #requireBridge(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const token = bearerToken(
      request.headers.authorization,
    );
    if (
      token &&
      constantTimeEqual(
        Buffer.from(token, "utf8"),
        this.#bridgeToken,
      )
    ) {
      return true;
    }

    response.statusCode = 401;
    response.setHeader(
      "www-authenticate",
      "Bearer",
    );
    response.end();
    return false;
  }

  async #requireDevice(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<string | null> {
    const deviceId = singleHeader(
      request.headers[DEVICE_ID_HEADER],
    );
    const credential = deviceToken(
      request.headers.authorization,
    );

    const accountId =
      deviceId && credential
        ? await this.#devices.authenticateDevice(
            deviceId,
            credential,
          )
        : null;
    if (accountId) {
      return accountId;
    }

    response.statusCode = 401;
    response.setHeader(
      "www-authenticate",
      "Device",
    );
    response.end();
    return null;
  }
}

function constantTimeEqual(
  actual: Buffer,
  expected: Buffer,
): boolean {
  if (actual.length !== expected.length) {
    const dummy = Buffer.alloc(expected.length);
    timingSafeEqual(dummy, expected);
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function bearerToken(
  header: string | undefined,
): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(
    header.trim(),
  );
  return match?.[1]?.trim() || null;
}

function deviceToken(
  header: string | undefined,
): string | null {
  if (!header) return null;
  const match = /^Device\s+(.+)$/i.exec(
    header.trim(),
  );
  return match?.[1]?.trim() || null;
}

function singleHeader(
  value: string | string[] | undefined,
): string | null {
  if (
    typeof value === "string" &&
    value.trim()
  ) {
    return value.trim();
  }
  return null;
}

async function readObjectBody(
  request: IncomingMessage,
  maxBytes = 32 * 1024,
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
        "auth login proof request exceeds size limit",
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
      "auth login proof body must be a JSON object",
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

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader(
    "content-type",
    "application/json",
  );
  response.setHeader(
    "cache-control",
    "no-store",
  );
  response.end(payload);
}
