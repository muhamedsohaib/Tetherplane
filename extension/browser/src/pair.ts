import {
  saveExtensionLaunchConfig,
  type ChromeStorageArea,
} from "./chrome-adapter.ts";
import { requestLocalPairing } from "./local-pairing.ts";
import {
  activatePairing,
} from "./pair-activation.ts";
import {
  detachCurrentTab,
  shareCurrentTab,
  type PopupBrowserApi,
} from "./popup-actions.ts";

const pairLocalElement =
  document.querySelector<HTMLButtonElement>("#pair-local");
const formElement =
  document.querySelector<HTMLFormElement>("#pair-form");
const bridgeUrlElement =
  document.querySelector<HTMLInputElement>("#bridge-url");
const launchTokenElement =
  document.querySelector<HTMLInputElement>("#launch-token");
const statusElement =
  document.querySelector<HTMLElement>("#status");
const shareTtlElement =
  document.querySelector<HTMLSelectElement>("#share-ttl");
const shareNavigateElement =
  document.querySelector<HTMLInputElement>("#share-navigate");
const shareUploadElement =
  document.querySelector<HTMLInputElement>("#share-upload");
const shareCurrentElement =
  document.querySelector<HTMLButtonElement>("#share-current");
const detachCurrentElement =
  document.querySelector<HTMLButtonElement>("#detach-current");
const shareStatusElement =
  document.querySelector<HTMLElement>("#share-status");

if (
  !pairLocalElement ||
  !formElement ||
  !bridgeUrlElement ||
  !launchTokenElement ||
  !statusElement ||
  !shareTtlElement ||
  !shareNavigateElement ||
  !shareUploadElement ||
  !shareCurrentElement ||
  !detachCurrentElement ||
  !shareStatusElement
) {
  throw new Error("Tetherplane browser popup is incomplete");
}

const pairLocalButton = pairLocalElement;
const form = formElement;
const bridgeUrl = bridgeUrlElement;
const launchToken = launchTokenElement;
const status = statusElement;
const shareTtl = shareTtlElement;
const shareNavigate = shareNavigateElement;
const shareUpload = shareUploadElement;
const shareCurrent = shareCurrentElement;
const detachCurrent = detachCurrentElement;
const shareStatus = shareStatusElement;

const sessionStorage =
  chrome.storage.session as unknown as ChromeStorageArea;

const popupApi: PopupBrowserApi = {
  activeTabs: () =>
    chrome.tabs.query({
      active: true,
      currentWindow: true,
    }),

  sendMessage: (message) =>
    chrome.runtime.sendMessage(message),
};

pairLocalButton.addEventListener("click", () => {
  void pairLocally();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void pairManually();
});

shareCurrent.addEventListener("click", () => {
  void share();
});

detachCurrent.addEventListener("click", () => {
  void detach();
});

async function activate(
  config: {
    bridge_url: string;
    launch_token: string;
  },
): Promise<void> {
  await activatePairing(
    config,
    {
      save: (value) =>
        saveExtensionLaunchConfig(
          sessionStorage,
          value,
        ),

      sendMessage: (message) =>
        chrome.runtime.sendMessage(message),
    },
  );
}

async function pairLocally(): Promise<void> {
  status.textContent = "";
  pairLocalButton.disabled = true;

  try {
    const config =
      await requestLocalPairing(
        fetch,
        chrome.runtime.id,
      );

    await activate(config);

    status.textContent =
      "Paired. Connecting...";
  } catch (error) {
    status.textContent =
      error instanceof Error
        ? error.message
        : "Local pairing failed";
  } finally {
    pairLocalButton.disabled = false;
  }
}

async function pairManually(): Promise<void> {
  status.textContent = "";

  try {
    await activate({
      bridge_url: bridgeUrl.value,
      launch_token: launchToken.value,
    });

    launchToken.value = "";

    status.textContent =
      "Paired. Connecting...";
  } catch (error) {
    launchToken.value = "";

    status.textContent =
      error instanceof Error
        ? error.message
        : "Pairing failed";
  }
}

async function share(): Promise<void> {
  shareStatus.textContent = "";

  try {
    const ttlMs = Number(shareTtl.value);

    const response =
      await shareCurrentTab(
        popupApi,
        {
          ttl_ms: ttlMs,
          allow_navigate:
            shareNavigate.checked,
          allow_upload:
            shareUpload.checked,
        },
      );

    assertApprovalResponse(response);

    shareStatus.textContent =
      "Current tab shared. Grant expires automatically.";
  } catch (error) {
    shareStatus.textContent =
      error instanceof Error
        ? error.message
        : "Share failed";
  }
}

async function detach(): Promise<void> {
  shareStatus.textContent = "";

  try {
    const response =
      await detachCurrentTab(popupApi);

    assertApprovalResponse(response);

    shareStatus.textContent =
      "Current tab is no longer shared.";
  } catch (error) {
    shareStatus.textContent =
      error instanceof Error
        ? error.message
        : "Detach failed";
  }
}

function assertApprovalResponse(
  response: unknown,
): void {
  if (
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    (response as { ok?: unknown }).ok !== true
  ) {
    const message =
      typeof response === "object" &&
      response !== null &&
      "error" in response &&
      typeof (
        response as { error?: unknown }
      ).error === "string"
        ? (response as { error: string }).error
        : "Local approval request failed";

    throw new Error(message);
  }
}