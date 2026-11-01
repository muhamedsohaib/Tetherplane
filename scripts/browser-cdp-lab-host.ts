/**
 * Explicitly opt-in test harness for Tetherplane's existing extension-free CDP
 * transport. No Chrome extension, human-owned browser profile, or personal
 * website credentials are involved.
 *
 * NOT a production browser broker. Deliberately limited to one HTTP loopback
 * Browser Lab origin; real website access requires independently audited
 * owner grants, network interception and profile isolation.
 */
import { readFile } from "node:fs/promises";
import {
  BrowserBridgeService,
  CdpBrowserBackend,
  findInstalledChromium,
  launchCdpOwnedBrowser,
  startBrowserRpcServer,
} from "../browser/bridge/src/index.ts";
import { CdpLabOnlyBridgeService, requireLoopbackLabOrigin } from
  "../browser/bridge/src/cdp-lab-service.ts";
import { startCdpLabProxy } from "../browser/bridge/src/cdp-lab-proxy.ts";
import {
  GRANTABLE_LAB_OPERATIONS,
  LocalBrowserLabGrant,
} from "../browser/bridge/src/local-lab-grant.ts";

async function main(): Promise<void> {
  if (process.env.TETHERPLANE_CDP_LAB_MODE !== "1") {
    throw new Error("CDP_LAB_REQUIRES_EXPLICIT_OPT_IN");
  }

  const labOrigin = requireLoopbackLabOrigin(
    process.env.TETHERPLANE_CDP_LAB_ORIGIN ?? "",
  );
  const tokenFile = process.env.TETHERPLANE_CDP_LAB_TOKEN_FILE;
  if (!tokenFile) {
    throw new Error("CDP_LAB_REQUIRES_LOCAL_TOKEN_FILE");
  }
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (token.length < 16 || token.length > 512 || /[\r\n\0]/.test(token)) {
    throw new Error("CDP_LAB_TOKEN_INVALID");
  }

  // Human/operator-configured laboratory opt-in only. Never model RPC.
  const privatePipe = process.env.TETHERPLANE_CDP_LAB_PRIVATE_PIPE === "1";
  const executablePath = findInstalledChromium();
  if (!executablePath) {
    throw new Error("CDP_LAB_CHROMIUM_NOT_AVAILABLE");
  }

  // A test grant exists only in this local process, never in model RPC.
  const grant = new LocalBrowserLabGrant({
    origin: labOrigin,
    operations: GRANTABLE_LAB_OPERATIONS,
    expiresAtMs: Date.now() + 10 * 60_000,
  });
  // CDP Fetch interception alone misses WebSocket handshakes. A separate
  // local proxy denies CONNECT/Upgrade and checks the active grant on HTTP.
  const proxy = await startCdpLabProxy({
    approvedOrigin: labOrigin,
    canForward: () => grant.isActive,
  });
  const control = await launchCdpOwnedBrowser({
    executablePath,
    privatePipe,
    networkOrigin: labOrigin,
    labProxyPort: proxy.port,
  }).catch(async (error: unknown) => {
    await proxy.close();
    throw error;
  });
  const backend = new CdpBrowserBackend({
    control, pollIntervalMs: 20,
    // Independent backend enforcement; permission never comes from model RPC.
    authorizeSite: (operation, url) =>
      grant.authorize(
        operation as Parameters<LocalBrowserLabGrant["authorize"]>[0], url,
      ),
  });
  let server: Awaited<ReturnType<typeof startBrowserRpcServer>> | null = null;
  let resolveStop!: () => void;
  const stop = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  process.once("SIGINT", resolveStop);
  process.once("SIGTERM", resolveStop);

  // Test-only cleanup channel; avoids orphaning Chromium in Windows CI.
  if (process.env.TETHERPLANE_CDP_LAB_TEST_STDIN_STOP === "1") {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
      if (input.includes("\n")) {
        if (input.trim() === "STOP_CDP_LAB") {
          resolveStop();
        }
        input = "";
      }
    });
    process.stdin.resume();
  }

  try {
    const service: BrowserBridgeService = new CdpLabOnlyBridgeService({
      backend,
      labOrigin,
      grant,
    });
    server = await startBrowserRpcServer({
      host: "127.0.0.1",
      port: 0,
      token,
      service,
    });
    process.stdout.write(`CDP_LAB_RPC_READY=${server.address}\n`);
    process.stdout.write("CDP_LAB_MODE=ISOLATED_EPHEMERAL_NO_EXTENSION\n");
    process.stdout.write(`CDP_LAB_TRANSPORT=${privatePipe ? "PRIVATE_PIPE" : "TCP_LAB_ONLY"}\n`);
    await stop;
  } finally {
    grant.revoke();
    await server?.close().catch(() => undefined);
    await backend.shutdown();
    await proxy.close();
    process.stdin.pause();
    process.stdout.write("CDP_LAB_SHUTDOWN=COMPLETE\n");
  }
}

await main().catch(() => {
  // Never leak file contents, browser URLs, tokens, or exception paths.
  process.stderr.write("CDP_LAB_FAILED=CHECK_LOCAL_CONFIGURATION\n");
  process.exitCode = 1;
});
