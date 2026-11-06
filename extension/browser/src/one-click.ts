import type { ShareCurrentTabOptions } from "./popup-actions.ts";

export type OwnerBrowserStatus = {
  paired: boolean;
  connected: boolean;
  shared: boolean;
  expires_at_ms?: number;
};

export type OneClickDependencies = {
  status(): Promise<OwnerBrowserStatus>;
  resume(): Promise<void>;
  pair(): Promise<void>;
  share(options: ShareCurrentTabOptions): Promise<unknown>;
  sleep(milliseconds: number): Promise<void>;
};

// A single owner-popup gesture provides a bounded grant for one tab.
// This helper never creates site-wide grants or exposes pairing credentials.
export async function connectCurrentTab(
  deps: OneClickDependencies,
  options: ShareCurrentTabOptions,
): Promise<OwnerBrowserStatus> {
  if (
    !Number.isSafeInteger(options.ttl_ms) ||
    options.ttl_ms <= 0 ||
    options.ttl_ms > 3_600_000
  ) {
    throw new Error("Choose a share duration between 1 and 60 minutes");
  }

  let state = await deps.status();
  if (!state.connected && state.paired) {
    await deps.resume();
    state = await waitForConnection(deps, 16);
  }

  if (!state.connected) {
    await deps.pair();
    state = await waitForConnection(deps, 28);
  }

  if (!state.connected) {
    throw new Error(
      "Extension is paired but the local browser host is not connected. " +
      "Check that Tetherplane is running on this computer.",
    );
  }

  const response = await deps.share(options);
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    !("ok" in response) ||
    (response as { ok?: unknown }).ok !== true
  ) {
    const error =
      response && typeof response === "object" &&
      !Array.isArray(response) && "error" in response &&
      typeof (response as { error?: unknown }).error === "string"
        ? (response as { error: string }).error
        : "Tetherplane did not authorize this tab";
    throw new Error(error);
  }

  const verified = await deps.status();
  if (!verified.connected || !verified.shared) {
    throw new Error(
      "The tab grant was not confirmed. No access should be assumed.",
    );
  }
  return verified;
}

async function waitForConnection(
  deps: OneClickDependencies,
  attempts: number,
): Promise<OwnerBrowserStatus> {
  let state = await deps.status();
  for (let i = 0; i < attempts && !state.connected; i++) {
    await deps.sleep(200);
    state = await deps.status();
  }
  return state;
}
