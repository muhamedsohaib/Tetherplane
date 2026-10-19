export type Device = {
  deviceId: string;
  pairedAt: string;
  revokedAt: string | null;
  connectivity: "relay_connected" | "relay_disconnected" | "not_reported";
  version: null;
};

export class PortalError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class RelayClient {
  readonly origin: string;

  constructor(relayUrl: string) {
    const url = new URL(relayUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname))
      )
    ) {
      throw new Error(
        "Relay must be an HTTPS origin, or numeric loopback HTTP origin for local development.",
      );
    }
    this.origin = url.origin;
  }

  async directory(token: string): Promise<Device[]> {
    const result = await this.#request("/devices", token);
    if (
      !isObject(result) ||
      !Array.isArray(result.devices) ||
      result.devices.length > 1000
    )
      throw invalidResponse();
    const seen = new Set<string>();
    return result.devices.map((raw) => {
      if (
        !isObject(raw) ||
        typeof raw.deviceId !== "string" ||
        !validDeviceId(raw.deviceId) ||
        seen.has(raw.deviceId) ||
        !timestamp(raw.pairedAt) ||
        !(raw.revokedAt === null || timestamp(raw.revokedAt))
      ) {
        throw invalidResponse();
      }
      // Older relays do not report transport presence. Never infer it from
      // pairing records or unrelated "online" fields.
      if (
        (raw.relayConnected !== undefined &&
          typeof raw.relayConnected !== "boolean") ||
        (raw.revokedAt !== null && raw.relayConnected === true)
      ) throw invalidResponse();
      seen.add(raw.deviceId);
      return {
        deviceId: raw.deviceId,
        pairedAt: raw.pairedAt as string,
        revokedAt: raw.revokedAt as string | null,
        connectivity:
          raw.relayConnected === true
            ? "relay_connected"
            : raw.relayConnected === false
              ? "relay_disconnected"
              : "not_reported",
        version: null,
      };
    });
  }

  async revoke(token: string, deviceId: string): Promise<void> {
    if (!validDeviceId(deviceId))
      throw new PortalError(400, "invalid_request", "Invalid device ID.");
    const result = await this.#request(
      `/devices/${encodeURIComponent(deviceId)}/revoke`,
      token,
      "POST",
    );
    if (
      !isObject(result) ||
      result.deviceId !== deviceId ||
      !timestamp(result.revokedAt)
    )
      throw invalidResponse();
  }

  async approvePairing(token: string, userCode: string): Promise<string> {
    const result = await this.#request("/pair/approve", token, "POST", { userCode });
    if (
      !isObject(result) || typeof result.deviceId !== "string" ||
      !validDeviceId(result.deviceId) || !timestamp(result.pairedAt) ||
      result.revokedAt !== null
    ) throw invalidResponse();
    return result.deviceId;
  }

  async #request(
    path: string,
    token: string,
    method = "GET",
    body: Record<string, unknown> = {},
  ): Promise<unknown> {
    try {
      const response = await fetch(this.origin + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (path === "/pair/approve" && response.status === 400)
          throw new PortalError(400, "pairing_rejected",
            "The relay could not approve this code. Refresh the directory, then check the code on your device before trying again.");
        if (response.status === 401)
          throw new PortalError(
            401,
            "authentication_required",
            "Relay authorization expired or was denied. Sign in again with an authorized credential.",
          );
        if (response.status === 403)
          throw new PortalError(
            403,
            "permission_denied",
            "The relay denied this operation.",
          );
        throw new PortalError(
          502,
          "relay_unavailable",
          "The relay could not complete the request. Refresh before trying again.",
        );
      }
      if (
        !(response.headers.get("content-type") ?? "")
          .toLowerCase()
          .startsWith("application/json")
      ) {
        await response.body?.cancel();
        throw invalidResponse();
      }
      const reader = response.body?.getReader();
      if (!reader) throw invalidResponse();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256 * 1024) {
            await reader.cancel();
            throw invalidResponse();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof PortalError) throw error;
      throw new PortalError(
        502,
        "relay_unavailable",
        "The relay is unavailable or returned an unsafe response. Check its address and refresh.",
      );
    }
  }
}

export function validDeviceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function timestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function invalidResponse(): PortalError {
  return new PortalError(
    502,
    "invalid_relay_response",
    "The relay returned an unsupported device record. No device status was inferred.",
  );
}
