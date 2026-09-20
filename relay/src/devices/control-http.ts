import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";

import type {
  ClientAuthenticator,
  ClientIdentity,
} from "../auth/static-auth.ts";
import type { DeviceRegistry } from "./registry.ts";

export class RelayControlHttpGateway {
  readonly #registry: DeviceRegistry;
  readonly #authenticator: ClientAuthenticator;
  readonly #disconnectDevice: (deviceId: string) => void;
  #attachedServer: Server | null = null;
  #requestHandler:
    | ((request: IncomingMessage, response: ServerResponse) => void)
    | null = null;

  constructor(options: {
    registry: DeviceRegistry;
    authenticator: ClientAuthenticator;
    disconnectDevice(deviceId: string): void;
  }) {
    this.#registry = options.registry;
    this.#authenticator = options.authenticator;
    this.#disconnectDevice = options.disconnectDevice;
  }

  attach(server: Server): void {
    if (this.#attachedServer) {
      throw new Error("relay control HTTP gateway is already attached");
    }
    this.#attachedServer = server;
    this.#requestHandler = (request, response) => {
      void this.#handleRequest(request, response);
    };
    server.on("request", this.#requestHandler);
  }

  close(): void {
    if (this.#attachedServer && this.#requestHandler) {
      this.#attachedServer.off("request", this.#requestHandler);
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
        url.pathname === "/pair/start"
      ) {
        await this.#startPairing(request, response);
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/pair/approve"
      ) {
        const identity = await this.#requireIdentity(
          request,
          response,
        );
        if (!identity) return;
        await this.#approvePairing(request, response, identity);
        return;
      }

      if (
        request.method === "GET" &&
        url.pathname === "/devices"
      ) {
        const identity = await this.#requireIdentity(
          request,
          response,
        );
        if (!identity) return;
        writeJson(response, 200, {
          devices: this.#registry.listDevices(identity.accountId),
        });
        return;
      }

      const revoke = /^\/devices\/([^/]+)\/revoke$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && revoke) {
        const identity = await this.#requireIdentity(
          request,
          response,
        );
        if (!identity) return;
        await this.#revokeDevice(
          response,
          identity,
          decodeURIComponent(revoke[1]!),
        );
      }
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      writeJson(response, 400, {
        error: {
          code: "invalid_arguments",
          message:
            error instanceof Error
              ? error.message
              : "invalid relay control request",
        },
      });
    }
  }

  async #startPairing(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readObjectBody(request);
    const deviceId = stringField(body, "deviceId");
    const credentialHash = stringField(
      body,
      "credentialHash",
    );
    const pending = await this.#registry.startPairing({
      deviceId,
      credentialHash,
    });
    writeJson(response, 200, pending);
  }

  async #approvePairing(
    request: IncomingMessage,
    response: ServerResponse,
    identity: ClientIdentity,
  ): Promise<void> {
    const body = await readObjectBody(request);
    const userCode = stringField(body, "userCode");
    const binding = await this.#registry.approvePairing({
      accountId: identity.accountId,
      userCode,
    });
    writeJson(response, 200, binding);
  }

  async #revokeDevice(
    response: ServerResponse,
    identity: ClientIdentity,
    deviceId: string,
  ): Promise<void> {
    const binding = this.#registry.getDevice(deviceId);
    if (
      !binding ||
      binding.accountId !== identity.accountId
    ) {
      writeJson(response, 403, {
        error: {
          code: "permission_denied",
          message: "device is not owned by this account",
        },
      });
      return;
    }

    const revoked = await this.#registry.revokeDevice({
      accountId: identity.accountId,
      deviceId,
    });
    this.#disconnectDevice(deviceId);
    writeJson(response, 200, revoked);
  }

  async #requireIdentity(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<ClientIdentity | null> {
    const token = bearerToken(request.headers.authorization);
    const identity = token
      ? await this.#authenticator.authenticate(token)
      : null;
    if (identity) return identity;

    response.statusCode = 401;
    response.setHeader("www-authenticate", "Bearer");
    response.end();
    return null;
  }
}

async function readObjectBody(
  request: IncomingMessage,
  maxBytes = 64 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new Error("request body exceeds relay control limit");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function stringField(
  body: Record<string, unknown>,
  name: string,
): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
