import { z } from "zod";
import { OidcClientAuthenticator } from "./auth/oidc-auth.ts";
import {
  StaticClientAuthenticator,
  type ClientAuthenticator,
} from "./auth/static-auth.ts";
import type { OAuthResource } from "./auth/oauth-resource.ts";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  StaticClientCredential,
} from "./auth/static-auth.ts";

export type RelayCliOptions = {
  host: string;
  port: number;
  stateFile: string;
  authConfig: string;
  tlsCert?: string;
  tlsKey?: string;
  allowInsecureLocalhost: boolean;
};

export function parseRelayArgs(
  args: string[],
): RelayCliOptions {
  let host = "127.0.0.1";
  let port = 8788;
  let stateFile = path.join(
    os.homedir(),
    ".tetherplane",
    "relay",
    "devices.json",
  );
  let authConfig: string | undefined;
  let tlsCert: string | undefined;
  let tlsKey: string | undefined;
  let allowInsecureLocalhost = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    switch (argument) {
      case "--host":
        host = requiredValue(args, ++index, "--host");
        break;
      case "--port": {
        const raw = requiredValue(args, ++index, "--port");
        const parsed = Number(raw);
        if (
          !Number.isInteger(parsed) ||
          parsed < 1 ||
          parsed > 65_535
        ) {
          throw new Error(
            "--port must be an integer between 1 and 65535",
          );
        }
        port = parsed;
        break;
      }
      case "--state-file":
        stateFile = requiredValue(
          args,
          ++index,
          "--state-file",
        );
        break;
      case "--auth-config":
        authConfig = requiredValue(
          args,
          ++index,
          "--auth-config",
        );
        break;
      case "--tls-cert":
        tlsCert = requiredValue(args, ++index, "--tls-cert");
        break;
      case "--tls-key":
        tlsKey = requiredValue(args, ++index, "--tls-key");
        break;
      case "--allow-insecure-localhost":
        allowInsecureLocalhost = true;
        break;
      default:
        throw new Error(
          `unknown tether-relay argument: ${argument}`,
        );
    }
  }

  if (!authConfig) {
    throw new Error("tether-relay requires --auth-config");
  }
  if ((tlsCert === undefined) !== (tlsKey === undefined)) {
    throw new Error(
      "--tls-cert and --tls-key must be provided together",
    );
  }
  if (
    tlsCert === undefined &&
    !allowInsecureLocalhost
  ) {
    throw new Error(
      "TLS is required unless --allow-insecure-localhost is explicitly enabled",
    );
  }

  return {
    host,
    port,
    stateFile,
    authConfig,
    ...(tlsCert === undefined
      ? {}
      : { tlsCert, tlsKey: tlsKey! }),
    allowInsecureLocalhost,
  };
}

export async function loadStaticClientCredentials(
  configPath: string,
  environment: Record<string, string | undefined> =
    process.env,
): Promise<StaticClientCredential[]> {
  const content = await readFile(configPath, "utf8");
  const parsed = JSON.parse(content) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("relay auth config must be a JSON object");
  }

  const clients = (parsed as Record<string, unknown>).clients;
  if (!Array.isArray(clients) || clients.length === 0) {
    throw new Error(
      "relay auth config requires a non-empty clients array",
    );
  }

  return clients.map((raw, index) =>
    parseClient(raw, index, environment),
  );
}

function parseClient(
  raw: unknown,
  index: number,
  environment: Record<string, string | undefined>,
): StaticClientCredential {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `relay auth client ${index} must be an object`,
    );
  }
  const record = raw as Record<string, unknown>;

  if ("token" in record) {
    throw new Error(
      "raw token values are not allowed in relay auth config; use token_env",
    );
  }

  const allowed = new Set([
    "token_env",
    "account_id",
    "client_id",
    "principal_id",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(
        `unsupported relay auth client field: ${key}`,
      );
    }
  }

  const tokenEnv = configString(record, "token_env", index);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new Error(
      `relay auth client ${index} token_env is not a valid environment variable name`,
    );
  }
  const token = environment[tokenEnv];
  if (!token) {
    throw new Error(
      `relay auth token environment variable is missing: ${tokenEnv}`,
    );
  }

  return {
    token,
    accountId: configString(record, "account_id", index),
    clientId: configString(record, "client_id", index),
    principalId: configString(
      record,
      "principal_id",
      index,
    ),
  };
}

function configString(
  record: Record<string, unknown>,
  name: string,
  index: number,
): string {
  const value = record[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `relay auth client ${index} requires non-empty ${name}`,
    );
  }
  return value.trim();
}

function requiredValue(
  args: string[],
  index: number,
  flag: string,
): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

const oidcCommon = {
  issuer: z.string(),
  audience: z.string(),
  jwksUri: z.string(),
  scopes: z.array(z.string()).min(1),
};

const oidcBindingSchema = z
  .object({
    ...oidcCommon,
    bindings: z
      .array(
        z
          .object({
            subject: z.string(),
            clientId: z.string(),
            accountId: z.string(),
            principalId: z.string(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const oidcSubjectSchema = z
  .object({
    ...oidcCommon,
    identity: z
      .object({
        strategy: z.literal("subject"),
        principalPrefix: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const oidcConfigSchema = z
  .object({
    oidc: z.union([oidcBindingSchema, oidcSubjectSchema]),
  })
  .strict();

export async function loadClientAuth(
  configPath: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<{
  authenticator: ClientAuthenticator;
  oauth?: OAuthResource;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error(
      "Unable to read relay auth configuration JSON",
    );
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "oidc" in parsed
  ) {
    const result = oidcConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("Invalid OIDC auth configuration");
    }
    const oidc = result.data.oidc;
    return {
      authenticator: new OidcClientAuthenticator(oidc),
      oauth: {
        resource: oidc.audience,
        issuer: oidc.issuer,
        scopes: oidc.scopes,
      },
    };
  }

  return {
    authenticator: new StaticClientAuthenticator(
      await loadStaticClientCredentials(
        configPath,
        environment,
      ),
    ),
  };
}
