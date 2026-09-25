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

export type TetherAuthProviderHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

export type TetherAuthTlsOptions = {
  cert: string | Buffer;
  key: string | Buffer;
};

export type TetherAuthServerOptions = {
  providerHandler: TetherAuthProviderHandler;
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
  readonly #tls: TetherAuthTlsOptions | undefined;
  readonly #allowInsecureLocalhost: boolean;
  #server: HttpServer | null = null;

  constructor(options: TetherAuthServerOptions) {
    if (typeof options.providerHandler !== "function") {
      throw new Error("tether-auth requires an OIDC provider handler");
    }
    this.#providerHandler = options.providerHandler;
    this.#tls = options.tls;
    this.#allowInsecureLocalhost =
      options.allowInsecureLocalhost ?? false;
  }

  async listen(
    options: TetherAuthListenOptions,
  ): Promise<TetherAuthAddress> {
    if (this.#server) {
      throw new Error("tether-auth server is already started");
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
      const pathname = safePathname(request.url);
      if (
        request.method === "GET" &&
        pathname === "/healthz"
      ) {
        writeProbe(response, { status: "ok" });
        return;
      }
      if (
        request.method === "GET" &&
        pathname === "/readyz"
      ) {
        writeProbe(response, { status: "ready" });
        return;
      }

      this.#providerHandler(request, response);
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
    throw new Error("tether-auth host must be non-empty");
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

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function writeProbe(
  response: ServerResponse,
  payload: { status: "ok" | "ready" },
): void {
  const body = JSON.stringify(payload);
  response.statusCode = 200;
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
  const protocol = secure ? "https" : "http";
  const host =
    address.family === "IPv6"
      ? `[${address.address}]`
      : address.address;
  return `${protocol}://${host}:${address.port}`;
}
