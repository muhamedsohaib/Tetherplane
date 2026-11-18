import { z } from "zod";
import {
  OidcClientAuthenticator,
  type OidcOptions,
} from "./auth/oidc-auth.ts";
import {
  StaticClientAuthenticator,
  validateConfiguredIdentityRole,
  type ClientAuthenticator,
  type ClientIdentityRole,
  type StaticClientCredential,
} from "./auth/static-auth.ts";
import type { OAuthResource } from "./auth/oauth-resource.ts";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type RelayCliOptions = {
  host: string;
  port: number;
  stateFile: string;
  authConfig: string;
  tlsCert?: string;
  tlsKey?: string;
  allowInsecureLocalhost: boolean;
  publicOrigin?: string;
  trustProxyHeaders: boolean;
};

export function validatePublicOrigin(rawValue: string): string {
  const trimmed = rawValue.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("--public-origin must be a valid absolute URL");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "--public-origin must not contain credentials, path, query, or fragment",
    );
  }
  if (parsed.protocol === "https:") {
    return parsed.origin;
  }
  if (parsed.protocol === "http:" && isLoopbackOriginHost(parsed.hostname)) {
    return parsed.origin;
  }
  throw new Error(
    "--public-origin must use https:// (or http:// on loopback only)",
  );
}

function isLoopbackOriginHost(host: string): boolean {
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
  let publicOrigin: string | undefined;
  let trustProxyHeaders = false;

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
      case "--public-origin":
        publicOrigin = validatePublicOrigin(
          requiredValue(args, ++index, "--public-origin"),
        );
        break;
      case "--trust-proxy-headers":
        trustProxyHeaders = true;
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
  if (trustProxyHeaders && !publicOrigin) {
    throw new Error(
      "--trust-proxy-headers requires explicit --public-origin",
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
    ...(publicOrigin ? { publicOrigin } : {}),
    trustProxyHeaders,
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
    "role",
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

  const principalId = configString(
    record,
    "principal_id",
    index,
  );
  let role: ClientIdentityRole | undefined;
  if ("role" in record && record.role !== undefined) {
    if (record.role !== "owner" && record.role !== "operator") {
      throw new Error(
        `relay auth client ${index} role must be 'owner' or 'operator'`,
      );
    }
    role = record.role;
    validateConfiguredIdentityRole(
      principalId,
      role,
      `relay auth client ${index}`,
    );
  }

  return {
    token,
    accountId: configString(record, "account_id", index),
    clientId: configString(record, "client_id", index),
    principalId,
    ...(role ? { role } : {}),
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

const oidcRoleSchema = z.enum(["owner", "operator"]).optional();

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
            role: oidcRoleSchema,
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
        role: oidcRoleSchema,
      })
      .strict(),
  })
  .strict();

const bridgeConfigSchema = z
  .object({
    tokenEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  })
  .strict();

const oidcConfigSchema = z
  .object({
    oidc: z.union([oidcBindingSchema, oidcSubjectSchema]),
    deviceLoginBridge: bridgeConfigSchema.optional(),
  })
  .strict();

export async function loadClientAuth(
  configPath: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<{
  authenticator: ClientAuthenticator;
  oauth?: OAuthResource;
  authLoginBridgeToken?: string;
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
    const rawOidc = result.data.oidc;
    const oidc: OidcOptions =
      "bindings" in rawOidc
        ? {
            issuer: rawOidc.issuer,
            audience: rawOidc.audience,
            jwksUri: rawOidc.jwksUri,
            scopes: rawOidc.scopes,
            bindings: rawOidc.bindings.map((binding) => ({
              subject: binding.subject,
              clientId: binding.clientId,
              accountId: binding.accountId,
              principalId: binding.principalId,
              ...(binding.role ? { role: binding.role } : {}),
            })),
          }
        : {
            issuer: rawOidc.issuer,
            audience: rawOidc.audience,
            jwksUri: rawOidc.jwksUri,
            scopes: rawOidc.scopes,
            identity: {
              strategy: rawOidc.identity.strategy,
              principalPrefix: rawOidc.identity.principalPrefix,
              ...(rawOidc.identity.role
                ? { role: rawOidc.identity.role }
                : {}),
            },
          };
    const bridge = result.data.deviceLoginBridge;
    const authLoginBridgeToken =
      bridge === undefined
        ? undefined
        : environment[bridge.tokenEnv];
    if (
      bridge !== undefined &&
      !authLoginBridgeToken
    ) {
      throw new Error(
        `relay auth bridge environment variable is missing: ${bridge.tokenEnv}`,
      );
    }
    return {
      authenticator: new OidcClientAuthenticator(oidc),
      oauth: {
        resource: oidc.audience,
        issuer: oidc.issuer,
        scopes: oidc.scopes,
      },
      ...(authLoginBridgeToken
        ? { authLoginBridgeToken }
        : {}),
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
