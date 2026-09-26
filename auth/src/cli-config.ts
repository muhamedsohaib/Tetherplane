import { readFile } from "node:fs/promises";
import path from "node:path";

export type TetherAuthCliOptions = {
  config: string;
  host: string;
  port: number;
  tlsCert?: string;
  tlsKey?: string;
  allowInsecureLocalhost: boolean;
};

export type TetherAuthDeploymentConfig = {
  issuer: string;
  resource: string;
  interactionBasePath: "/interaction";
  databasePath: string;
  jwks: {
    keys: Array<Record<string, unknown>>;
  };
  relay: {
    url: string;
    bridgeToken: string;
    allowInsecureLocalhost: boolean;
  };
};

export function parseTetherAuthArgs(
  args: string[],
): TetherAuthCliOptions {
  let config: string | undefined;
  let host = "127.0.0.1";
  let port = 8790;
  let tlsCert: string | undefined;
  let tlsKey: string | undefined;
  let allowInsecureLocalhost = false;

  for (
    let index = 0;
    index < args.length;
    index += 1
  ) {
    const argument = args[index]!;
    switch (argument) {
      case "--config":
        config = requiredValue(
          args,
          ++index,
          "--config",
        );
        break;
      case "--host":
        host = requiredValue(
          args,
          ++index,
          "--host",
        );
        break;
      case "--port": {
        const raw = requiredValue(
          args,
          ++index,
          "--port",
        );
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
      case "--tls-cert":
        tlsCert = requiredValue(
          args,
          ++index,
          "--tls-cert",
        );
        break;
      case "--tls-key":
        tlsKey = requiredValue(
          args,
          ++index,
          "--tls-key",
        );
        break;
      case "--allow-insecure-localhost":
        allowInsecureLocalhost = true;
        break;
      default:
        throw new Error(
          `unknown tether-auth argument: ${argument}`,
        );
    }
  }

  if (!config) {
    throw new Error(
      "tether-auth requires --config",
    );
  }
  if (
    (tlsCert === undefined) !==
    (tlsKey === undefined)
  ) {
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
  if (
    tlsCert === undefined &&
    !isLoopbackHost(host)
  ) {
    throw new Error(
      "plaintext tether-auth binding is restricted to loopback",
    );
  }

  return {
    config,
    host,
    port,
    ...(tlsCert
      ? {
          tlsCert,
          tlsKey: tlsKey!,
        }
      : {}),
    allowInsecureLocalhost,
  };
}

export async function loadTetherAuthDeploymentConfig(
  configPath: string,
  environment: Record<
    string,
    string | undefined
  > = process.env,
): Promise<TetherAuthDeploymentConfig> {
  const parsed = await readJsonObject(
    configPath,
    "auth deployment config",
  );

  assertOnlyFields(
    parsed,
    [
      "issuer",
      "resource",
      "databasePath",
      "jwksFile",
      "relay",
    ],
    "auth config",
  );

  const issuer = requireHttpsOriginOrUrl(
    requiredString(
      parsed,
      "issuer",
      "auth config",
    ),
    "issuer",
  );
  const resource = requireCanonicalResource(
    requiredString(
      parsed,
      "resource",
      "auth config",
    ),
  );

  const rawDatabasePath = requiredString(
    parsed,
    "databasePath",
    "auth config",
  );
  if (
    rawDatabasePath === ":memory:"
  ) {
    throw new Error(
      "auth databasePath must reference a persistent file",
    );
  }
  const databasePath = path.resolve(
    rawDatabasePath,
  );

  const jwksFile = path.resolve(
    requiredString(
      parsed,
      "jwksFile",
      "auth config",
    ),
  );
  const jwks = await readJwks(jwksFile);

  const relayRecord = requiredObject(
    parsed,
    "relay",
    "auth config",
  );
  assertOnlyFields(
    relayRecord,
    [
      "url",
      "bridgeTokenEnv",
      "allowInsecureLocalhost",
    ],
    "auth relay config",
  );

  const allowRelayInsecure =
    optionalBoolean(
      relayRecord,
      "allowInsecureLocalhost",
    ) ?? false;
  const relayUrl = normalizeRelayUrl(
    requiredString(
      relayRecord,
      "url",
      "auth relay config",
    ),
    allowRelayInsecure,
  );
  const bridgeTokenEnv =
    requiredString(
      relayRecord,
      "bridgeTokenEnv",
      "auth relay config",
    );
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(
      bridgeTokenEnv,
    )
  ) {
    throw new Error(
      "auth relay bridgeTokenEnv must be a valid environment variable name",
    );
  }
  const bridgeToken =
    environment[bridgeTokenEnv];
  if (!bridgeToken) {
    throw new Error(
      `auth relay bridge environment variable is missing: ${bridgeTokenEnv}`,
    );
  }
  if (
    bridgeToken.length < 32 ||
    /[\r\n]/.test(bridgeToken)
  ) {
    throw new Error(
      "auth relay bridge credential is invalid",
    );
  }

  return {
    issuer,
    resource,
    interactionBasePath:
      "/interaction",
    databasePath,
    jwks,
    relay: {
      url: relayUrl,
      bridgeToken,
      allowInsecureLocalhost:
        allowRelayInsecure,
    },
  };
}

async function readJwks(
  filePath: string,
): Promise<{
  keys: Array<Record<string, unknown>>;
}> {
  const parsed = await readJsonObject(
    filePath,
    "JWKS file",
  );
  assertOnlyFields(
    parsed,
    ["keys"],
    "JWKS file",
  );

  const keys = parsed.keys;
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.some(
      (key) =>
        !key ||
        typeof key !== "object" ||
        Array.isArray(key),
    )
  ) {
    throw new Error(
      "JWKS file requires a non-empty keys array",
    );
  }

  return {
    keys: keys.map((key) => ({
      ...(key as Record<
        string,
        unknown
      >),
    })),
  };
}

async function readJsonObject(
  filePath: string,
  label: string,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(
        filePath,
        "utf8",
      ),
    );
  } catch {
    throw new Error(
      `Unable to read ${label} JSON`,
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `${label} must be a JSON object`,
    );
  }
  return parsed as Record<
    string,
    unknown
  >;
}

function assertOnlyFields(
  record: Record<string, unknown>,
  allowedFields: string[],
  label: string,
): void {
  const allowed = new Set(
    allowedFields,
  );
  for (
    const field of Object.keys(record)
  ) {
    if (!allowed.has(field)) {
      throw new Error(
        `unsupported ${label} field: ${field}`,
      );
    }
  }
}

function requiredObject(
  record: Record<string, unknown>,
  field: string,
  label: string,
): Record<string, unknown> {
  const value = record[field];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      `${label} requires object field ${field}`,
    );
  }
  return value as Record<
    string,
    unknown
  >;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(
      `${label} requires non-empty ${field}`,
    );
  }
  return value.trim();
}

function optionalBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(
      `${field} must be boolean`,
    );
  }
  return value;
}

function requireHttpsOriginOrUrl(
  value: string,
  label: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${label} must be an absolute HTTPS URL`,
    );
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `${label} must be an absolute HTTPS URL without credentials, query, or fragment`,
    );
  }
  return url.toString();
}

function requireCanonicalResource(
  value: string,
): string {
  const normalized =
    requireHttpsOriginOrUrl(
      value,
      "resource",
    );
  const url = new URL(normalized);
  if (url.pathname !== "/mcp") {
    throw new Error(
      "resource must be the canonical HTTPS /mcp URL",
    );
  }
  return normalized;
}

function normalizeRelayUrl(
  value: string,
  allowInsecureLocalhost: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "auth relay URL must be an absolute URL",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" &&
      url.pathname !== "")
  ) {
    throw new Error(
      "auth relay URL must be an origin",
    );
  }

  if (url.protocol === "https:") {
    return url.origin;
  }
  if (
    url.protocol === "http:" &&
    allowInsecureLocalhost &&
    isLoopbackHost(url.hostname)
  ) {
    return url.origin;
  }

  throw new Error(
    "auth relay URL requires HTTPS unless insecure loopback mode is explicitly enabled",
  );
}

function isLoopbackHost(
  value: string,
): boolean {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost"
  );
}

function requiredValue(
  args: string[],
  index: number,
  flag: string,
): string {
  const value = args[index];
  if (
    !value ||
    value.startsWith("--")
  ) {
    throw new Error(
      `${flag} requires a value`,
    );
  }
  return value;
}
