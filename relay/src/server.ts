import type { OAuthResource } from "./auth/oauth-resource.ts";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import {
  createServer as createHttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import type { AddressInfo } from "node:net";

import type {
  ClientAuthenticator,
} from "./auth/static-auth.ts";
import {
  DeviceRegistry,
} from "./devices/registry.ts";
import {
  RelayControlHttpGateway,
} from "./devices/control-http.ts";
import {
  DeviceWebSocketGateway,
} from "./devices/ws-gateway.ts";
import {
  RemoteMcpHttpGateway,
} from "./mcp/http-gateway.ts";
import {
  DeviceRouter,
} from "./routing/device-router.ts";
import { RelayHealthHttpGateway } from "./health-http.ts";

type NodeRelayServer =
  | ReturnType<typeof createHttpServer>
  | ReturnType<typeof createHttpsServer>;

export type RelayListenAddress = {
  host: string;
  port: number;
  httpUrl: string;
  mcpUrl: string;
  deviceWsUrl: string;
};

export class RelayServer {
  readonly registry: DeviceRegistry;
  readonly router: DeviceRouter;
  readonly deviceGateway: DeviceWebSocketGateway;
  readonly mcpGateway: RemoteMcpHttpGateway;
  readonly controlGateway: RelayControlHttpGateway;
  readonly healthGateway: RelayHealthHttpGateway;
  readonly isSecure: boolean;

  readonly #server: NodeRelayServer;
  readonly #allowInsecureLocalhost: boolean;
  #closed = false;

  private constructor(options: {
    server: NodeRelayServer;
    secure: boolean;
    allowInsecureLocalhost: boolean;
    registry: DeviceRegistry;
    router: DeviceRouter;
    deviceGateway: DeviceWebSocketGateway;
    mcpGateway: RemoteMcpHttpGateway;
    controlGateway: RelayControlHttpGateway;
    healthGateway: RelayHealthHttpGateway;
  }) {
    this.#server = options.server;
    this.isSecure = options.secure;
    this.#allowInsecureLocalhost =
      options.allowInsecureLocalhost;
    this.registry = options.registry;
    this.router = options.router;
    this.deviceGateway = options.deviceGateway;
    this.mcpGateway = options.mcpGateway;
    this.controlGateway = options.controlGateway;
    this.healthGateway = options.healthGateway;
  }

  static async create(options: {
    authenticator: ClientAuthenticator;
    oauth?: OAuthResource;
    stateFile?: string;
    tls?: HttpsServerOptions;
    allowInsecureLocalhost?: boolean;
    routeTimeoutMs?: number;
  }): Promise<RelayServer> {
    const registry = await DeviceRegistry.open(
      options.stateFile
        ? { stateFile: options.stateFile }
        : {},
    );
    const router = new DeviceRouter({
      registry,
      ...(options.routeTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.routeTimeoutMs }),
    });
    const deviceGateway = new DeviceWebSocketGateway({
      registry,
      router,
    });
    const mcpGateway = new RemoteMcpHttpGateway({
      router,
      authenticator: options.authenticator,
      ...(options.oauth ? { oauth: options.oauth } : {}),
    });
    const healthGateway = new RelayHealthHttpGateway();
    const controlGateway = new RelayControlHttpGateway({
      registry,
      authenticator: options.authenticator,
      disconnectDevice: (deviceId) =>
        deviceGateway.disconnectDevice(deviceId),
    });

    const secure = options.tls !== undefined;
    const server: NodeRelayServer =
      options.tls === undefined
        ? createHttpServer()
        : createHttpsServer(options.tls);

    const httpCompatible = server as unknown as HttpServer;
    healthGateway.attach(httpCompatible);
    deviceGateway.attach(httpCompatible, "/device");
    mcpGateway.attach(httpCompatible, "/mcp");
    controlGateway.attach(httpCompatible);

    return new RelayServer({
      server,
      secure,
      allowInsecureLocalhost:
        options.allowInsecureLocalhost ?? false,
      registry,
      router,
      deviceGateway,
      mcpGateway,
      controlGateway,
      healthGateway,
    });
  }

  async listen(options: {
    host: string;
    port: number;
  }): Promise<RelayListenAddress> {
    if (this.#closed) {
      throw new Error("relay server is closed");
    }
    if (!this.isSecure) {
      if (!this.#allowInsecureLocalhost) {
        throw new Error(
          "TLS is required unless insecure loopback mode is explicitly enabled",
        );
      }
      if (!isLoopbackHost(options.host)) {
        throw new Error(
          "plaintext relay transport is restricted to loopback; configure TLS for non-loopback binding",
        );
      }
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(options.port, options.host);
    });

    const address = this.#server.address();
    if (!address || typeof address === "string") {
      throw new Error("relay server did not expose a TCP address");
    }

    return this.#formatAddress(address, options.host);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    this.healthGateway.close();
    this.controlGateway.close();
    await this.mcpGateway.close();
    await this.deviceGateway.close();

    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  #formatAddress(
    address: AddressInfo,
    requestedHost: string,
  ): RelayListenAddress {
    const host = normalizeDisplayHost(
      requestedHost || address.address,
    );
    const httpScheme = this.isSecure ? "https" : "http";
    const wsScheme = this.isSecure ? "wss" : "ws";
    const authority = formatAuthority(host, address.port);
    const httpUrl = `${httpScheme}://${authority}`;

    return {
      host,
      port: address.port,
      httpUrl,
      mcpUrl: `${httpUrl}/mcp`,
      deviceWsUrl: `${wsScheme}://${authority}/device`,
    };
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function normalizeDisplayHost(host: string): string {
  return host.trim() || "127.0.0.1";
}

function formatAuthority(
  host: string,
  port: number,
): string {
  const formattedHost =
    host.includes(":") && !host.startsWith("[")
      ? `[${host}]`
      : host;
  return `${formattedHost}:${port}`;
}
