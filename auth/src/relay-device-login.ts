import type {
  DeviceLoginProof,
  DeviceLoginProofConsumer,
  DeviceLoginProofInput,
} from "./device-login.ts";

export type RelayDeviceLoginProofClientOptions = {
  relayUrl: string;
  bridgeToken: string;
  allowInsecureLocalhost?: boolean;
  fetchImpl?: typeof fetch;
};

export type DeviceLoginStartInput = {
  interactionUid: string;
};

export type DeviceLoginStartResult = {
  userCode: string;
  expiresAt: string;
};

export class RelayDeviceLoginProofClient
  implements DeviceLoginProofConsumer
{
  readonly #baseUrl: string;
  readonly #bridgeToken: string;
  readonly #fetch: typeof fetch;

  constructor(
    options: RelayDeviceLoginProofClientOptions,
  ) {
    this.#baseUrl = normalizeRelayUrl(
      options.relayUrl,
      options.allowInsecureLocalhost ?? false,
    );
    if (
      typeof options.bridgeToken !== "string" ||
      options.bridgeToken.length < 32 ||
      /[\r\n]/.test(options.bridgeToken)
    ) {
      throw new Error(
        "relay device-login bridge value must contain at least 32 safe characters",
      );
    }
    this.#bridgeToken = options.bridgeToken;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async start(
    input: DeviceLoginStartInput,
  ): Promise<DeviceLoginStartResult> {
    validateInteractionUid(input.interactionUid);

    const response = await this.#post(
      "/auth/device-login/start",
      {
        interactionUid: input.interactionUid,
      },
    );
    if (!response.ok) {
      throw upstreamFailure(
        "start",
        response.status,
      );
    }

    const body = await readObjectResponse(response);
    const userCode = body.userCode;
    const expiresAt = body.expiresAt;
    if (
      typeof userCode !== "string" ||
      !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(
        userCode,
      )
    ) {
      throw new Error(
        "relay device-login start response has invalid code",
      );
    }
    if (
      typeof expiresAt !== "string" ||
      !Number.isFinite(Date.parse(expiresAt))
    ) {
      throw new Error(
        "relay device-login start response has invalid expiry",
      );
    }

    return {
      userCode,
      expiresAt,
    };
  }

  async consume(
    input: DeviceLoginProofInput,
  ): Promise<DeviceLoginProof | null> {
    validateInteractionUid(input.interactionUid);
    validateUserCode(input.userCode);

    const response = await this.#post(
      "/auth/device-login/consume",
      {
        interactionUid: input.interactionUid,
        userCode: input.userCode,
      },
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw upstreamFailure(
        "consume",
        response.status,
      );
    }

    const body = await readObjectResponse(response);
    const accountId = body.accountId;
    if (
      typeof accountId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
        accountId,
      )
    ) {
      throw new Error(
        "relay device-login response has invalid account",
      );
    }

    return {
      accountId,
    };
  }

  async #post(
    pathname: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return this.#fetch(
      this.#baseUrl + pathname,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization:
            `Bearer ${this.#bridgeToken}`,
        },
        body: JSON.stringify(body),
        redirect: "error",
      },
    );
  }
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
      "relay URL must be an absolute HTTPS URL",
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
      "relay URL must be an origin without credentials, path, query, or fragment",
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
    "relay URL requires HTTPS unless insecure loopback mode is explicitly enabled",
  );
}

function isLoopbackHost(
  value: string,
): boolean {
  const host = value
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost"
  );
}

function validateInteractionUid(
  value: string,
): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._~-]{8,256}$/.test(value)
  ) {
    throw new Error(
      "device-login interaction uid is invalid",
    );
  }
}

function validateUserCode(
  value: string,
): void {
  if (
    typeof value !== "string" ||
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value)
  ) {
    throw new Error(
      "device-login code is invalid",
    );
  }
}

async function readObjectResponse(
  response: Response,
  maxBytes = 16 * 1024,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (
    Buffer.byteLength(text, "utf8") >
    maxBytes
  ) {
    throw new Error(
      "relay device-login response exceeds size limit",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "relay device-login response is not valid JSON",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "relay device-login response must be an object",
    );
  }
  return parsed as Record<string, unknown>;
}

function upstreamFailure(
  operation: string,
  status: number,
): Error {
  return new Error(
    `relay device-login ${operation} failed with HTTP ${status}`,
  );
}
