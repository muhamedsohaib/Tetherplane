import type { OAuthResource } from "./auth/oauth-resource.ts";
import { AuthLoginProofHttpGateway } from "./auth/login-proof-http.ts";
import { AuthLoginProofRegistry } from "./auth/login-proof-registry.ts";
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
  type RelayRateLimitConfig,
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
import { validatePublicOrigin } from "./cli-config.ts";
import { RelayHealthHttpGateway } from "./health-http.ts";
import { PolicyStore } from "./policy/policy-store.ts";
import type { PersistFileOps } from "./persistence/atomic-json.ts";

type NodeRelayServer =
  | ReturnType<typeof createHttpServer>
  | ReturnType<typeof createHttpsServer>;

export type RelayListenAddress = {
  host: string;
  port: number;
  httpUrl: string;
  mcpUrl: string;
  deviceWsUrl: string;
  portalUrl?: string;
};

export class RelayServer {
  readonly registry: DeviceRegistry;
  readonly policyStore: PolicyStore;
  readonly router: DeviceRouter;
  readonly deviceGateway: DeviceWebSocketGateway;
  readonly mcpGateway: RemoteMcpHttpGateway;
  readonly controlGateway: RelayControlHttpGateway;
  readonly healthGateway: RelayHealthHttpGateway;
  readonly authLoginGateway: AuthLoginProofHttpGateway | null;
  readonly isSecure: boolean;

  readonly #server: NodeRelayServer;
  readonly #allowInsecureLocalhost: boolean;
  readonly #publicOrigin: string | null;
  #closed = false;

  private constructor(options: {
    server: NodeRelayServer;
    secure: boolean;
    allowInsecureLocalhost: boolean;
    publicOrigin: string | null;
    registry: DeviceRegistry;
    policyStore: PolicyStore;
    router: DeviceRouter;
    deviceGateway: DeviceWebSocketGateway;
    mcpGateway: RemoteMcpHttpGateway;
    controlGateway: RelayControlHttpGateway;
    healthGateway: RelayHealthHttpGateway;
    authLoginGateway: AuthLoginProofHttpGateway | null;
  }) {
    this.#server = options.server;
    this.isSecure = options.secure;
    this.#allowInsecureLocalhost =
      options.allowInsecureLocalhost;
    this.#publicOrigin = options.publicOrigin;
    this.registry = options.registry;
    this.policyStore = options.policyStore;
    this.router = options.router;
    this.deviceGateway = options.deviceGateway;
    this.mcpGateway = options.mcpGateway;
    this.controlGateway = options.controlGateway;
    this.healthGateway = options.healthGateway;
    this.authLoginGateway = options.authLoginGateway;
  }

  static async create(options: {
    authenticator: ClientAuthenticator;
    oauth?: OAuthResource;
    stateFile?: string;
    tls?: HttpsServerOptions;
    allowInsecureLocalhost?: boolean;
    publicOrigin?: string;
    trustProxyHeaders?: boolean;
    routeTimeoutMs?: number;
    authLoginBridgeToken?: string;
    maxPendingPairings?: number;
    maxAuditHistory?: number;
    rateLimits?: RelayRateLimitConfig;
    persistOps?: PersistFileOps;
  }): Promise<RelayServer> {
    const publicOrigin =
      options.publicOrigin === undefined
        ? null
        : validatePublicOrigin(options.publicOrigin);
    const trustProxyHeaders = options.trustProxyHeaders ?? false;
    if (trustProxyHeaders && !publicOrigin) {
      throw new Error("trustProxyHeaders requires explicit publicOrigin");
    }

    const registry = await DeviceRegistry.open({
      ...(options.stateFile ? { stateFile: options.stateFile } : {}),
      ...(options.maxPendingPairings !== undefined
        ? { maxPendingPairings: options.maxPendingPairings }
        : {}),
      ...(options.persistOps ? { persistOps: options.persistOps } : {}),
    });
    const policyStore = await PolicyStore.open({
      registry,
      ...(options.stateFile
        ? { stateFile: options.stateFile }
        : {}),
      ...(options.maxAuditHistory !== undefined
        ? { maxAuditHistory: options.maxAuditHistory }
        : {}),
      ...(options.persistOps ? { persistOps: options.persistOps } : {}),
    });
    const router = new DeviceRouter({
      registry,
      policyStore,
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
    const secure = options.tls !== undefined;
    const secureCookies =
      secure || (publicOrigin?.startsWith("https:") ?? false);
    const controlGateway = new RelayControlHttpGateway({
      registry,
      policyStore,
      authenticator: options.authenticator,
      secureCookies,
      ...(publicOrigin ? { publicOrigin } : {}),
      trustProxyHeaders,
      ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
      disconnectDevice: (deviceId) =>
        deviceGateway.disconnectDevice(deviceId),
    });
    const authLoginGateway =
      options.authLoginBridgeToken === undefined
        ? null
        : new AuthLoginProofHttpGateway({
            devices: registry,
            proofs: new AuthLoginProofRegistry(),
            bridgeToken: options.authLoginBridgeToken,
          });
    const server: NodeRelayServer =
      options.tls === undefined
        ? createHttpServer()
        : createHttpsServer(options.tls);

    const httpCompatible = server as unknown as HttpServer;
    healthGateway.attach(httpCompatible);
    deviceGateway.attach(httpCompatible, "/device");
    mcpGateway.attach(httpCompatible, "/mcp");
    controlGateway.attach(httpCompatible);
    authLoginGateway?.attach(httpCompatible);

    return new RelayServer({
      server,
      secure,
      allowInsecureLocalhost:
        options.allowInsecureLocalhost ?? false,
      publicOrigin,
      registry,
      policyStore,
      router,
      deviceGateway,
      mcpGateway,
      controlGateway,
      healthGateway,
      authLoginGateway,
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
    this.authLoginGateway?.close();
    await this.mcpGateway.close();
    await this.deviceGateway.close();

    if (!this.#server.listening) return;
    this.#server.closeIdleConnections?.();
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
      ...(this.#publicOrigin
        ? { portalUrl: `${this.#publicOrigin}/portal` }
        : {}),
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
