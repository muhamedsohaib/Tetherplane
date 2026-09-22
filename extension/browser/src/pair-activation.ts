import type {
  ExtensionLaunchConfig,
} from "./chrome-adapter.ts";

export const BROWSER_CONNECT_MESSAGE_TYPE =
  "tetherplane.browser.connect";

export type PairActivationDependencies = {
  save(config: ExtensionLaunchConfig): Promise<void>;
  sendMessage(
    message: Record<string, unknown>,
  ): Promise<unknown>;
};

export async function activatePairing(
  config: ExtensionLaunchConfig,
  dependencies: PairActivationDependencies,
): Promise<void> {
  await dependencies.save(config);

  const response = await dependencies.sendMessage({
    type: BROWSER_CONNECT_MESSAGE_TYPE,
  });

  if (
    typeof response !== "object" ||
    response === null ||
    Array.isArray(response) ||
    !("ok" in response) ||
    (response as { ok?: unknown }).ok !== true
  ) {
    const message =
      typeof response === "object" &&
      response !== null &&
      !Array.isArray(response) &&
      "error" in response &&
      typeof (response as { error?: unknown }).error === "string"
        ? (response as { error: string }).error
        : "Authenticated browser connection could not start";

    throw new Error(message);
  }
}

export function isBrowserConnectMessage(
  value: unknown,
): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    (value as { type?: unknown }).type ===
      BROWSER_CONNECT_MESSAGE_TYPE
  );
}