#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import {
  loadClientAuth,
  parseRelayArgs,
} from "./cli-config.ts";
import { RelayServer } from "./server.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }

  const options = parseRelayArgs(args);
  const {
    authenticator,
    oauth,
    authLoginBridgeToken,
  } = await loadClientAuth(options.authConfig);

  const tls =
    options.tlsCert && options.tlsKey
      ? {
          cert: await readFile(options.tlsCert),
          key: await readFile(options.tlsKey),
        }
      : undefined;

  const relay = await RelayServer.create({
    stateFile: options.stateFile,
    authenticator,
    ...(oauth ? { oauth } : {}),
    ...(authLoginBridgeToken
      ? { authLoginBridgeToken }
      : {}),
    ...(tls ? { tls } : {}),
    allowInsecureLocalhost:
      options.allowInsecureLocalhost,
    ...(options.publicOrigin
      ? { publicOrigin: options.publicOrigin }
      : {}),
    trustProxyHeaders: options.trustProxyHeaders,
    ...(options.portalPort !== undefined
      ? { portalPort: options.portalPort }
      : {}),
    portalReadOnly: options.portalReadOnly,
  });

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await relay.close();
  };

  process.once("SIGINT", () => {
    void close().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().then(() => process.exit(0));
  });

  try {
    const address = await relay.listen({
      host: options.host,
      port: options.port,
    });
    process.stdout.write(
      [
        `tether-relay listening on ${address.httpUrl}`,
        `MCP: ${address.mcpUrl}`,
        `Device: ${address.deviceWsUrl}`,
        ...(address.portalListenUrl
          ? [`Portal (loopback-only): ${address.portalListenUrl}/portal`]
          : []),
        ...(address.portalUrl ? [`Portal: ${address.portalUrl}`] : []),
        ...(options.portalReadOnly
          ? ["Portal mode: read-only pilot (policy mutations disabled)"]
          : []),
      ].join("\n") + "\n",
    );
  } catch (error) {
    await close();
    throw error;
  }
}

function usage(): string {
  return `Tetherplane relay

Usage:
  tether-relay --auth-config <path> [options]

Required security:
  --tls-cert <path> --tls-key <path>
    Serve HTTPS/WSS directly.

  --allow-insecure-localhost
    Permit HTTP/WS only on localhost/loopback, intended for local
    development or a trusted same-host TLS/OIDC reverse proxy.

Options:
  --auth-config <path>       OIDC configuration or static token_env metadata.
  --state-file <path>       Device registry state file.
  --host <host>             Bind host. Default: 127.0.0.1.
  --port <port>             Bind port. Default: 8788.
  --portal-port <port>      Serve /portal* ONLY on this loopback-only port (main port returns 404).
  --portal-read-only        Allow read-only portal visibility; reject all policy mutations (403).
  --tls-cert <path>         PEM certificate.
  --tls-key <path>          PEM private key.
  --allow-insecure-localhost
  --public-origin <origin>  External browser HTTPS origin behind a trusted proxy.
  --trust-proxy-headers     Verify X-Forwarded-Proto/Host against --public-origin.
  --help
`;
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "unknown tether-relay failure";
  process.stderr.write(`tether-relay: ${message}\n`);
  process.exitCode = 1;
});
