import {
  validateExtensionLaunchConfig,
  type ExtensionLaunchConfig,
} from "./chrome-adapter.ts";

export type PairingFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export async function requestLocalPairing(
  fetcher: PairingFetcher,
  extensionId: string,
  endpoint = "http://127.0.0.1:17656/pair",
): Promise<ExtensionLaunchConfig> {
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error("Chrome extension ID is invalid");
  }

  const parsed = new URL(endpoint);
  if (
    parsed.protocol !== "http:" ||
    !isLoopbackHost(parsed.hostname)
  ) {
    throw new Error(
      "Local Tetherplane pairing endpoint must use loopback HTTP",
    );
  }

  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      extension_id: extensionId,
    }),
  });

  if (!response.ok) {
    throw new Error("Local Tetherplane pairing was denied");
  }

  const payload = (await response.json()) as unknown;
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error("Local Tetherplane pairing response is invalid");
  }

  const record = payload as Record<string, unknown>;
  return validateExtensionLaunchConfig({
    bridge_url: record.bridge_url,
    launch_token: record.launch_token,
  });
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1"
  );
}
