import {
  saveExtensionLaunchConfig,
  type ChromeStorageArea,
} from "./chrome-adapter.ts";

const formElement =
  document.querySelector<HTMLFormElement>("#pair-form");
const bridgeUrlElement =
  document.querySelector<HTMLInputElement>("#bridge-url");
const launchTokenElement =
  document.querySelector<HTMLInputElement>("#launch-token");
const statusElement =
  document.querySelector<HTMLElement>("#status");

if (
  !formElement ||
  !bridgeUrlElement ||
  !launchTokenElement ||
  !statusElement
) {
  throw new Error("Tetherplane pairing UI is incomplete");
}

const form = formElement;
const bridgeUrl = bridgeUrlElement;
const launchToken = launchTokenElement;
const status = statusElement;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void pair();
});

async function pair(): Promise<void> {
  status.textContent = "";
  try {
    await saveExtensionLaunchConfig(
      chrome.storage.session as unknown as ChromeStorageArea,
      {
        bridge_url: bridgeUrl.value,
        launch_token: launchToken.value,
      },
    );
    launchToken.value = "";
    status.textContent = "Paired. Reconnecting…";
    chrome.runtime.reload();
  } catch (error) {
    launchToken.value = "";
    status.textContent =
      error instanceof Error ? error.message : "Pairing failed";
  }
}
