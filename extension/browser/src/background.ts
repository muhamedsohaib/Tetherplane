import {
  ChromeOwnershipStore,
  ChromeTabsAdapter,
  loadExtensionLaunchConfig,
  type ChromeStorageArea,
  type ChromeTabsApi,
} from "./chrome-adapter.ts";
import { handleLocalApprovalMessage } from "./approval.ts";
import { BridgeLoopCoordinator } from "./bridge-loop.ts";
import { ExtensionTabController } from "./index.ts";
import {
  isBrowserConnectMessage,
} from "./pair-activation.ts";
import {
  ChromePageAgent,
  type ChromeScriptingApi,
} from "./page-agent.ts";
import {
  ChromeOperationalAgent,
  type ChromeDebuggerApi,
  type ChromeDownloadsApi,
} from "./operations.ts";
import { ExtensionCommandRuntime } from "./runtime.ts";
import { ExtensionBridgeClient } from "./session.ts";

const RECONNECT_DELAY_MS = 1_000;

const sessionStorage =
  chrome.storage.session as unknown as ChromeStorageArea;

const controllerPromise = initializeController();

const bridgeLoop = new BridgeLoopCoordinator({
  hasConfig: async () =>
    (await loadExtensionLaunchConfig(sessionStorage)) !== null,

  runLoop: async () => {
    const controller = await controllerPromise;
    await runBridgeLoop(
      controller,
      sessionStorage,
    );
  },

  onLoopError: (error: unknown) => {
    console.error(
      "Tetherplane authenticated browser loop stopped",
      error,
    );
  },
});

chrome.runtime.onMessage.addListener(
  (message, _sender, sendResponse) => {
    if (isBrowserConnectMessage(message)) {
      void bridgeLoop.ensureRunning().then(
        (started) => {
          sendResponse(
            started
              ? { ok: true }
              : {
                  ok: false,
                  error:
                    "Authenticated browser pairing config is unavailable",
                },
          );
        },
        (error: unknown) => {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Authenticated browser connection failed to start",
          });
        },
      );

      return true;
    }

    void controllerPromise.then(
      (controller) =>
        handleLocalApprovalMessage(
          controller,
          message,
        ),
    ).then(
      (result) => {
        sendResponse({
          ok: true,
          ...result,
        });
      },
      (error: unknown) => {
        sendResponse({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Local approval failed",
        });
      },
    );

    return true;
  },
);

void bridgeLoop.ensureRunning().catch(
  (error: unknown) => {
    console.error(
      "Tetherplane authenticated browser startup failed",
      error,
    );
  },
);

async function initializeController(): Promise<ExtensionTabController> {
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
  return controller;
}

async function runBridgeLoop(
  controller: ExtensionTabController,
  storage: ChromeStorageArea,
): Promise<void> {
  for (;;) {
    const currentConfig =
      await loadExtensionLaunchConfig(storage);

    if (!currentConfig) {
      return;
    }

    const session = new ExtensionBridgeClient({
      url: currentConfig.bridge_url,
      launchToken: currentConfig.launch_token,
      extensionId: chrome.runtime.id,
    });

    let operationalAgent:
      | ChromeOperationalAgent
      | undefined;

    try {
      await session.connect();

      const pageAgent = new ChromePageAgent({
        controller,
        scripting:
          chrome.scripting as unknown as ChromeScriptingApi,
      });

      operationalAgent =
        new ChromeOperationalAgent({
          controller,
          debuggerApi:
            chrome.debugger as unknown as ChromeDebuggerApi,
          downloadsApi:
            chrome.downloads as unknown as ChromeDownloadsApi,
        });

      const runtime =
        new ExtensionCommandRuntime({
          session,
          controller,
          pageAgent,
          operationalAgent,
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
      await operationalAgent
        ?.close()
        .catch(() => undefined);

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