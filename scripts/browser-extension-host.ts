import path from "node:path";
import process from "node:process";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";

import {
  BrowserBridgeService,
  ExtensionBrowserBackend,
  startBrowserRpcServer,
  startExtensionBridgeServer,
  startExtensionPairingBroker,
  type BrowserRpcServer,
  type ExtensionPairingBroker,
} from "../browser/bridge/src/index.ts";

const localAppData =
  process.env.LOCALAPPDATA ??
  (() => {
    throw new Error("LOCALAPPDATA is required");
  })();

const root = path.join(localAppData, "Tetherplane");
const agentTokenFile =
  process.env.TETHERPLANE_BROWSER_BRIDGE_TOKEN_FILE ??
  path.join(root, "browser-bridge.token");
const extensionTokenFile =
  process.env.TETHERPLANE_EXTENSION_LAUNCH_TOKEN_FILE ??
  path.join(root, "browser-extension-launch.token");
const pinnedExtensionIdFile =
  process.env.TETHERPLANE_EXTENSION_ID_FILE ??
  path.join(root, "browser-extension.id");

const rpcPort = portFromEnv(
  "TETHERPLANE_AUTH_BROWSER_RPC_PORT",
  17657,
);
const pairingPort = portFromEnv(
  "TETHERPLANE_EXTENSION_PAIRING_PORT",
  17656,
);
const extensionPort = portFromEnv(
  "TETHERPLANE_EXTENSION_WS_PORT",
  17658,
);

await mkdir(root, { recursive: true });

const agentToken = await readSecret(
  agentTokenFile,
  "browser bridge token",
);
const extensionToken = await readSecret(
  extensionTokenFile,
  "extension launch token",
);

const extensionServer =
  await startExtensionBridgeServer({
    launchToken: extensionToken,
    port: extensionPort,
  });

let pairingBroker: ExtensionPairingBroker | null = null;
let browserRpc: BrowserRpcServer | null = null;
let stopping = false;
let resolveStop!: () => void;
const stopped = new Promise<void>((resolve) => {
  resolveStop = resolve;
});

process.stdout.write(
  `AUTH_EXTENSION_WS_READY=${extensionServer.url}\n`,
);

const requestStop = (): void => {
  if (stopping) {
    return;
  }
  stopping = true;
  resolveStop();
};

process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

try {
  while (!stopping) {
    const pinnedExtensionId =
      await readPinnedExtensionId(
        pinnedExtensionIdFile,
      );

    pairingBroker =
      await startExtensionPairingBroker({
        launchToken: extensionToken,
        bridgeUrl: extensionServer.url,
        port: pairingPort,
        ...(pinnedExtensionId
          ? { expectedExtensionId: pinnedExtensionId }
          : {}),
        onPaired: async (extensionId) => {
          if (!pinnedExtensionId) {
            await writeFile(
              pinnedExtensionIdFile,
              extensionId + "\n",
              {
                encoding: "utf8",
                flag: "wx",
              },
            ).catch(async (error: unknown) => {
              const current =
                await readPinnedExtensionId(
                  pinnedExtensionIdFile,
                );
              if (current !== extensionId) {
                throw error;
              }
            });
          }
        },
      });

    process.stdout.write(
      `AUTH_PAIRING_READY=${pairingBroker.url}/pair\n`,
    );

    const client = await Promise.race([
      extensionServer.waitForAuthenticatedClient(),
      stopped.then(() => null),
    ]);

    if (!client || stopping) {
      break;
    }

    await pairingBroker.close();
    pairingBroker = null;

    process.stdout.write(
      `AUTH_EXTENSION_CONNECTED=${client.extension_id}\n`,
    );

    const backend =
      new ExtensionBrowserBackend({
        transport: client,
        pollIntervalMs: 20,
      });

    browserRpc = await startBrowserRpcServer({
      service: new BrowserBridgeService({
        backend,
      }),
      token: agentToken,
      host: "127.0.0.1",
      port: rpcPort,
    });

    process.stdout.write(
      `AUTH_BROWSER_RPC_READY=${browserRpc.address}\n`,
    );

    await Promise.race([
      client.closed,
      stopped,
    ]);

    await browserRpc.close();
    browserRpc = null;

    if (!stopping) {
      process.stdout.write(
        "AUTH_EXTENSION_DISCONNECTED=True\n",
      );
    }
  }
} finally {
  await browserRpc?.close().catch(() => undefined);
  await pairingBroker?.close().catch(() => undefined);
  await extensionServer.close().catch(() => undefined);
}

function portFromEnv(
  name: string,
  fallback: number,
): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > 65_535
  ) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return parsed;
}

async function readSecret(
  filePath: string,
  label: string,
): Promise<string> {
  const value = (
    await readFile(filePath, "utf8")
  ).trim();
  if (!value) {
    throw new Error(`${label} file is empty`);
  }
  return value;
}

async function readPinnedExtensionId(
  filePath: string,
): Promise<string | null> {
  try {
    const value = (
      await readFile(filePath, "utf8")
    ).trim();
    if (!value) {
      return null;
    }
    if (!/^[a-p]{32}$/.test(value)) {
      throw new Error(
        "pinned Chrome extension ID is invalid",
      );
    }
    return value;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
