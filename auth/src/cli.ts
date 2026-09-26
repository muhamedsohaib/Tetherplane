#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import {
  loadTetherAuthDeploymentConfig,
  parseTetherAuthArgs,
} from "./cli-config.ts";
import {
  startTetherAuthProductionService,
} from "./production.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    args.includes("--help") ||
    args.includes("-h")
  ) {
    process.stdout.write(usage());
    return;
  }

  const options =
    parseTetherAuthArgs(args);
  const deployment =
    await loadTetherAuthDeploymentConfig(
      options.config,
    );

  const tls =
    options.tlsCert &&
    options.tlsKey
      ? {
          cert: await readFile(
            options.tlsCert,
          ),
          key: await readFile(
            options.tlsKey,
          ),
        }
      : undefined;

  const service =
    await startTetherAuthProductionService({
      deployment,
      listen: {
        host: options.host,
        port: options.port,
      },
      ...(tls
        ? {
            tls,
          }
        : {}),
      allowInsecureLocalhost:
        options.allowInsecureLocalhost,
    });

  process.stdout.write(
    [
      `tether-auth listening on ${service.address.url}`,
      `Issuer: ${deployment.issuer}`,
      `Resource: ${deployment.resource}`,
    ].join("\n") + "\n",
  );

  await service.closed;
}

function usage(): string {
  return `Tetherplane authorization server

Usage:
  tether-auth --config <path> [options]

Required security:
  --tls-cert <path> --tls-key <path>
    Serve HTTPS directly.

  --allow-insecure-localhost
    Permit HTTP only on localhost/loopback for local
    development or a trusted same-host TLS reverse proxy.

Options:
  --config <path>           Deployment metadata. Required.
  --host <host>             Bind host. Default: 127.0.0.1.
  --port <port>             Bind port. Default: 8790.
  --tls-cert <path>         PEM certificate file.
  --tls-key <path>          PEM private-key file.
  --allow-insecure-localhost
  --help

The deployment config references:
  - persistent SQLite state path
  - JWKS signing-key file
  - relay origin
  - bridge credential environment-variable name

Secret values are not accepted on the command line.
`;
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : "unknown tether-auth failure";
  process.stderr.write(
    `tether-auth: ${message}\n`,
  );
  process.exitCode = 1;
});
