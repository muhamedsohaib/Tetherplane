import {
  saveExtensionLaunchConfig,
  type ChromeStorageArea,
} from "./chrome-adapter.ts";
import { requestLocalPairing } from "./local-pairing.ts";
import {
  activatePairing,
  BROWSER_CONNECT_MESSAGE_TYPE,
  BROWSER_OWNER_STATUS_MESSAGE_TYPE,
} from "./pair-activation.ts";
import {
  connectCurrentTab,
  type OwnerBrowserStatus,
} from "./one-click.ts";
import { describeOwnerPopup } from "./popup-status.ts";
import {
  approveOwnedSite,
  revokeOwnedSite,
  detachCurrentTab,
  shareCurrentTab,
  type PopupBrowserApi,
} from "./popup-actions.ts";

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error("Tetherplane popup is missing " + selector);
  }
  return element;
}

const primary = getElement<HTMLButtonElement>("#quick-connect");
const disconnect = getElement<HTMLButtonElement>("#detach-current");
const indicator = getElement<HTMLElement>("#connection-indicator");
const connectionState = getElement<HTMLElement>("#connection-state");
const connectTitle = getElement<HTMLElement>("#connect-title");
const connectSummary = getElement<HTMLElement>("#connect-summary");
const grantPermissions = getElement<HTMLElement>("#grant-permissions");
const shareStatus = getElement<HTMLElement>("#share-status");
const status = getElement<HTMLElement>("#status");
const ttl = getElement<HTMLSelectElement>("#share-ttl");
const navigation = getElement<HTMLInputElement>("#share-navigate");
const upload = getElement<HTMLInputElement>("#share-upload");
const pairButton = getElement<HTMLButtonElement>("#pair-local");
const manualForm = getElement<HTMLFormElement>("#pair-form");
const bridgeUrl = getElement<HTMLInputElement>("#bridge-url");
const launchToken = getElement<HTMLInputElement>("#launch-token");
const allowSite = getElement<HTMLButtonElement>("#approve-owned-site");
const revokeSite = getElement<HTMLButtonElement>("#revoke-owned-site");

const sessionStorage =
  chrome.storage.session as unknown as ChromeStorageArea;

const popupApi: PopupBrowserApi = {
  activeTabs: () =>
    chrome.tabs.query({
      active: true,
      currentWindow: true,
    }),
  sendMessage: (message) => chrome.runtime.sendMessage(message),
};

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

let busy = false;

primary.addEventListener("click", () => { void connect(); });
disconnect.addEventListener("click", () => { void detach(); });
pairButton.addEventListener("click", () => { void pairLocally(); });
manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void pairManually();
});
allowSite.addEventListener("click", () => { void approveSite(); });
revokeSite.addEventListener("click", () => { void revokeSiteAccess(); });

void refresh().catch((error: unknown) => {
  setConnectionIndicator("disconnected", "Local connection unavailable");
  setMessage(shareStatus, humanError(error), true);
});

async function readStatus(): Promise<OwnerBrowserStatus> {
  const tabs = await popupApi.activeTabs();
  const id = tabs[0]?.id;
  const reply: unknown = await chrome.runtime.sendMessage({
    type: BROWSER_OWNER_STATUS_MESSAGE_TYPE,
    ...(typeof id === "number" && Number.isSafeInteger(id)
      ? { tab_id: id }
      : {}),
  });
  if (
    !reply || typeof reply !== "object" || Array.isArray(reply) ||
    !("ok" in reply) || (reply as { ok?: unknown }).ok !== true
  ) {
    throw new Error("Could not check extension connection status");
  }
  const record = reply as Record<string, unknown>;
  if (typeof record.paired !== "boolean" ||
      typeof record.connected !== "boolean" ||
      typeof record.shared !== "boolean") {
    throw new Error("Extension returned an invalid connection status");
  }
  return {
    paired: record.paired,
    connected: record.connected,
    shared: record.shared,
    ...(typeof record.expires_at_ms === "number"
      ? { expires_at_ms: record.expires_at_ms }
      : {}),
    ...(typeof record.grant_navigate === "boolean"
      ? { grant_navigate: record.grant_navigate }
      : {}),
    ...(typeof record.grant_upload === "boolean"
      ? { grant_upload: record.grant_upload }
      : {}),
  };
}

async function resume(): Promise<void> {
  const result = await chrome.runtime.sendMessage({
    type: BROWSER_CONNECT_MESSAGE_TYPE,
  });
  assertApprovalResponse(result);
}

async function activate(config: {
  bridge_url: string;
  launch_token: string;
}): Promise<void> {
  await activatePairing(config, {
    save: (value) => saveExtensionLaunchConfig(sessionStorage, value),
    sendMessage: (message) => chrome.runtime.sendMessage(message),
  });
}

async function requestPair(): Promise<void> {
  let config;
  try {
    config = await requestLocalPairing(fetch, chrome.runtime.id);
  } catch (error) {
    if (error instanceof TypeError || humanError(error) === "Failed to fetch") {
      throw new Error(
        "The local pairing service is unavailable. " +
        "Check that the Tetherplane browser host is running, then retry.",
      );
    }
    throw error;
  }
  await activate(config);
}

async function connect(): Promise<void> {
  if (busy) return;
  setBusy(true);
  setMessage(shareStatus, "Connecting and authorizing this tab…", false);
  setConnectionIndicator("connecting", "Connecting to local browser host…");

  try {
    const result = await connectCurrentTab(
      {
        status: readStatus,
        resume,
        pair: requestPair,
        share: (options) => shareCurrentTab(popupApi, options),
        sleep: pause,
      },
      {
        ttl_ms: Number(ttl.value),
        allow_navigate: navigation.checked,
        allow_upload: upload.checked,
      },
    );
    renderStatus(result);
  } catch (error) {
    try {
      renderStatus(await readStatus());
    } catch {
      setConnectionIndicator("error", "Local connection unavailable");
    }
    // An unsuccessful connect must remain visible even after status refresh.
    setMessage(shareStatus, humanError(error), true);
  } finally {
    setBusy(false);
  }
}

async function detach(): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    const response = await detachCurrentTab(popupApi);
    assertApprovalResponse(response);
    renderStatus(await readStatus());
    setMessage(shareStatus, "Sharing stopped for this tab.", false);
  } catch (error) {
    setMessage(shareStatus, humanError(error), true);
  } finally {
    setBusy(false);
  }
}

async function pairLocally(): Promise<void> {
  if (busy) return;
  setBusy(true);
  setMessage(status, "Connecting to Tetherplane…", false);
  try {
    const current = await readStatus();
    if (!current.connected) {
      if (current.paired) {
        await resume();
      } else {
        await requestPair();
      }
    }
    for (let i = 0; i < 16; i++) {
      if ((await readStatus()).connected) break;
      await pause(200);
    }
    const updated = await readStatus();
    renderStatus(updated);
    setMessage(
      status,
      updated.connected
        ? updated.shared
          ? "Connected. An existing local tab authorization is active."
          : "Connected. Select Connect this tab to authorize the active tab."
        : "Pairing saved. The browser host is still reconnecting.",
      false,
    );
  } catch (error) {
    setMessage(status, humanError(error), true);
  } finally {
    setBusy(false);
  }
}

async function pairManually(): Promise<void> {
  if (busy) return;
  setBusy(true);
  try {
    await activate({
      bridge_url: bridgeUrl.value,
      launch_token: launchToken.value,
    });
    setMessage(status, "Pairing accepted. Checking connection…", false);
    renderStatus(await readStatus());
  } catch (error) {
    setMessage(status, humanError(error), true);
  } finally {
    launchToken.value = "";
    setBusy(false);
  }
}

async function approveSite(): Promise<void> {
  try {
    const response = await approveOwnedSite(popupApi, {
      ttl_ms: Number(ttl.value),
      allow_navigate: navigation.checked,
      allow_upload: upload.checked,
    });
    assertApprovalResponse(response);
    setMessage(shareStatus, "Site access approved until the grant expires.", false);
  } catch (error) {
    setMessage(shareStatus, humanError(error), true);
  }
}

async function revokeSiteAccess(): Promise<void> {
  try {
    assertApprovalResponse(await revokeOwnedSite(popupApi));
    setMessage(shareStatus, "AI-created tab access revoked for this site.", false);
  } catch (error) {
    setMessage(shareStatus, humanError(error), true);
  }
}

async function refresh(): Promise<void> {
  renderStatus(await readStatus());
}

function renderStatus(state: OwnerBrowserStatus): void {
  const view = describeOwnerPopup(state);
  setConnectionIndicator(view.connectionState, view.connectionText);
  connectTitle.textContent = view.heading;
  connectSummary.textContent = view.summary;
  grantPermissions.textContent = view.permissionText;
  primary.dataset.idleLabel = view.connectLabel;
  if (!busy) primary.textContent = view.connectLabel;
  primary.classList.toggle("hidden", !view.showConnect);
  disconnect.classList.toggle("hidden", !view.showStopSharing);
  setMessage(shareStatus, view.statusText, false);
}

function setConnectionIndicator(
  state: "connected" | "connecting" | "disconnected" | "error",
  text: string,
): void {
  indicator.dataset.state = state;
  connectionState.textContent = text;
}

function setBusy(value: boolean): void {
  busy = value;
  primary.disabled = value;
  disconnect.disabled = value;
  pairButton.disabled = value;
  primary.textContent = value ? "Connecting…" : (primary.dataset.idleLabel ?? "Connect this tab");
}

function setMessage(
  element: HTMLElement,
  message: string,
  error: boolean,
): void {
  element.textContent = message;
  element.dataset.error = String(error);
}

function humanError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The browser connection could not be completed";
}

function assertApprovalResponse(response: unknown): void {
  if (
    typeof response !== "object" || response === null ||
    Array.isArray(response) || !("ok" in response) ||
    (response as { ok?: unknown }).ok !== true
  ) {
    const message =
      typeof response === "object" && response !== null &&
      !Array.isArray(response) && "error" in response &&
      typeof (response as { error?: unknown }).error === "string"
        ? (response as { error: string }).error
        : "Local owner approval failed";
    throw new Error(message);
  }
}
