import type { BrowserOperation } from "@tetherplane/browser-bridge/policy";
import type { OwnerBrowserStatus } from "./one-click.ts";

export type PopupConnectionState = "connected" | "connecting" | "disconnected";

export type OwnerPopupPresentation = {
  connectionState: PopupConnectionState;
  connectionText: string;
  heading: string;
  summary: string;
  statusText: string;
  permissionText: string;
  connectLabel: string;
  showConnect: boolean;
  showStopSharing: boolean;
};

export function grantPermissionFields(operations: readonly BrowserOperation[]): {
  grant_navigate: boolean;
  grant_upload: boolean;
} {
  return {
    grant_navigate: operations.includes("navigate"),
    grant_upload: operations.includes("upload"),
  };
}

// A saved local grant and an authenticated bridge connection are different
// conditions. Never describe an offline tab as remotely shared.
export function describeOwnerPopup(
  state: OwnerBrowserStatus,
  now = Date.now(),
): OwnerPopupPresentation {
  const activeShare = state.connected && state.shared;
  const savedOfflineGrant = state.shared && !state.connected;
  const minutes = typeof state.expires_at_ms === "number"
    ? Math.max(1, Math.ceil((state.expires_at_ms - now) / 60_000))
    : null;
  const expiry = minutes === null ? "until its recorded expiry"
    : `for ${minutes} more minute${minutes === 1 ? "" : "s"}`;

  let connectionState: PopupConnectionState;
  let connectionText: string;
  if (state.connected) {
    connectionState = "connected";
    connectionText = "Extension connected locally";
  } else if (state.paired) {
    connectionState = "connecting";
    connectionText = "Paired locally · connection unavailable";
  } else {
    connectionState = "disconnected";
    connectionText = savedOfflineGrant
      ? "Not connected · local tab grant remains"
      : "Not connected · pairing required";
  }

  let permissionText: string;
  if (state.shared) {
    if (typeof state.grant_navigate !== "boolean" ||
        typeof state.grant_upload !== "boolean") {
      permissionText = "Current grant permissions could not be confirmed. " +
        "Do not assume navigation or upload access.";
    } else {
      permissionText = `Recorded tab permissions: same-site navigation ${state.grant_navigate ? "allowed" : "not allowed"}; ` +
        `native file upload ${state.grant_upload ? "allowed" : "not allowed"}. ` +
        (activeShare ? "Access expires automatically." :
          "Remote access is unavailable until you reconnect.");
    }
  } else {
    permissionText = "Navigation and file uploads require explicit approval when connecting. " +
      "The options below apply to the next grant.";
  }

  return {
    connectionState,
    connectionText,
    heading: activeShare ? "Current tab connected"
      : savedOfflineGrant ? "Reconnect the current tab"
      : "Connect the current tab",
    summary: activeShare ? "This tab has an explicit grant. Other tabs require separate authorization."
      : savedOfflineGrant
        ? "This tab has a saved local authorization, but the remote browser connection is unavailable."
        : "Connect and authorize only this tab. Choose the duration and optional permissions below.",
    statusText: activeShare
      ? `This tab is shared ${expiry}.`
      : savedOfflineGrant
        ? `Local authorization saved ${expiry}, but remote access is unavailable. Reconnect or stop sharing.`
        : state.connected
          ? "This tab is not shared."
          : "No active remote sharing. Connect this tab to authorize access.",
    permissionText,
    connectLabel: savedOfflineGrant ? "Reconnect and share this tab" : "Connect this tab",
    showConnect: !activeShare,
    showStopSharing: state.shared,
  };
}
