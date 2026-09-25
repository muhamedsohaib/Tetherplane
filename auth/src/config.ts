export type TetherAuthConfiguration = {
  pkce: {
    methods: ["S256"];
    required(ctx: unknown, client: unknown): boolean;
  };
  features: {
    registration: {
      enabled: true;
    };
    resourceIndicators: {
      enabled: true;
      getResourceServerInfo(
        ctx: unknown,
        resourceIndicator: string,
        client: unknown,
      ): Promise<{
        audience: string;
        scope: string;
        accessTokenFormat: "jwt";
        accessTokenTTL: number;
      }>;
    };
  };
  interactions: {
    url(ctx: unknown, interaction: { uid: string }): string;
  };
};

export type TetherAuthConfigurationInput = {
  issuer: string;
  resource: string;
  interactionBasePath: string;
  invalidTarget(): Error;
};

const ACCESS_SCOPE = "tetherplane:access";
const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;

export function createTetherAuthConfiguration(
  input: TetherAuthConfigurationInput,
): TetherAuthConfiguration {
  const issuer = requireHttpsUrl(input.issuer, "issuer");
  const resource = requireHttpsUrl(input.resource, "resource");

  if (new URL(resource).pathname !== "/mcp") {
    throw new Error("resource must be the canonical HTTPS /mcp URL");
  }

  const interactionBasePath = normalizeInteractionPath(
    input.interactionBasePath,
  );

  return {
    pkce: {
      methods: ["S256"],
      required() {
        return true;
      },
    },
    features: {
      registration: {
        enabled: true,
      },
      resourceIndicators: {
        enabled: true,
        async getResourceServerInfo(
          _ctx,
          resourceIndicator,
          _client,
        ) {
          if (resourceIndicator !== resource) {
            throw input.invalidTarget();
          }
          return {
            audience: resource,
            scope: ACCESS_SCOPE,
            accessTokenFormat: "jwt",
            accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
          };
        },
      },
    },
    interactions: {
      url(_ctx, interaction) {
        if (
          !interaction ||
          typeof interaction.uid !== "string" ||
          !interaction.uid.trim()
        ) {
          throw new Error("interaction uid must be a non-empty string");
        }
        return `${interactionBasePath}/${encodeURIComponent(interaction.uid)}`;
      },
    },
  };
}

function requireHttpsUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }

  return parsed.toString();
}

function normalizeInteractionPath(value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    trimmed.endsWith("/")
  ) {
    throw new Error(
      "interactionBasePath must be an absolute path without query, fragment, or trailing slash",
    );
  }
  return trimmed;
}
