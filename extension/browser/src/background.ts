import {
  ChromeOwnershipStore,
  ChromeTabsAdapter,
  loadExtensionLaunchConfig,
  type ChromeStorageArea,
  type ChromeTabsApi,
} from "./chrome-adapter.ts";
import { ExtensionTabController } from "./index.ts";
import {
  ChromePageAgent,
  type ChromeScriptingApi,
} from "./page-agent.ts";
import { ExtensionCommandRuntime } from "./runtime.ts";
import { ExtensionBridgeClient } from "./session.ts";

const RECONNECT_DELAY_MS = 1_000;

async function bootExtension(): Promise<void> {
  const tabs = new ChromeTabsAdapter(
    chrome.tabs as unknown as ChromeTabsApi,
  );
  const ownershipStore = new ChromeOwnershipStore(
    chrome.storage.local as unknown as ChromeStorageArea,
  );
  const controller = new ExtensionTabController({
    tabs,
    store: ownershipStore,
  });
  await controller.initialize();

  const sessionStorage =
    chrome.storage.session as unknown as ChromeStorageArea;
  const config = await loadExtensionLaunchConfig(sessionStorage);
  if (!config) {
    return;
  }

  for (;;) {
    const currentConfig =
      await loadExtensionLaunchConfig(sessionStorage);
    if (!currentConfig) {
      return;
    }

    const session = new ExtensionBridgeClient({
      url: currentConfig.bridge_url,
      launchToken: currentConfig.launch_token,
      extensionId: chrome.runtime.id,
    });

    try {
      await session.connect();

      const pageAgent = new ChromePageAgent({
        controller,
        scripting:
          chrome.scripting as unknown as ChromeScriptingApi,
      });
      const runtime = new ExtensionCommandRuntime({
        session,
        controller,
        pageAgent,
      });

      session.send({
        type: "event",
        event: "extension_ready",
        data: {
          pages: controller.pages(),
        },
      });

      await runtime.run();
    } catch (error) {
      console.warn(
        "Tetherplane browser bridge connection ended",
        error,
      );
    } finally {
      session.close();
    }

    await sleep(RECONNECT_DELAY_MS);
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

void bootExtension().catch((error: unknown) => {
  console.error("Tetherplane browser extension failed to start", error);
});
