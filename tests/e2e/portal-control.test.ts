import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  BrowserBridgeService,
  HotSwappableBrowserBackend,
  findInstalledChromium,
  startBrowserRpcServer,
  type BrowserObservedState,
  type BrowserServiceBackend,
  type BrowserServicePage,
  type RawBrowserDiagnosticEvent,
  type RawBrowserDownload,
  type ResolvedBrowserAction,
} from "@tetherplane/browser-bridge";
import {
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "@tetherplane/relay";

async function until<T>(
  predicate: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 15_000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class LiveFakeBrowserBackend implements BrowserServiceBackend {
  capabilities() {
    return {
      backend: "extension",
      connected: true,
      status: "ready",
      operations: ["status", "pages", "create_tab", "snapshot"],
    };
  }
  async pages(): Promise<BrowserServicePage[]> {
    return [
      {
        page_id: "owned-live-1",
        ownership: "tetherplane",
        active: false,
        url: "https://example.test/app",
      },
    ];
  }
  async createTab(url: string): Promise<BrowserServicePage> {
    return { page_id: "owned-live-2", ownership: "tetherplane", active: false, url };
  }
  async navigate(pageId: string, url: string): Promise<BrowserServicePage> {
    return { page_id: pageId, ownership: "tetherplane", active: false, url };
  }
  async close(): Promise<void> {}
  async observe(pageId: string): Promise<BrowserObservedState> {
    return {
      page_id: pageId,
      url: "https://example.test/app",
      semantic_revision: 1,
      resource_revision: "1",
      nodes: [],
      validation_messages: [],
      toasts: [],
    };
  }
  async perform(_pageId: string, _action: ResolvedBrowserAction): Promise<void> {}
  async waitForSettled(pageId: string): Promise<BrowserObservedState> {
    return this.observe(pageId);
  }
  async uploadFile(): Promise<void> {}
  async downloads(): Promise<RawBrowserDownload[]> {
    return [];
  }
  async diagnostics(): Promise<RawBrowserDiagnosticEvent[]> {
    return [];
  }
}

class HeadlessBrowser {
  readonly #child: ChildProcess;
  readonly #ws: globalThis.WebSocket;
  readonly #pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  #nextId = 1;
  #sessionId = "";
  readonly consoleErrors: string[] = [];
  readonly exceptions: string[] = [];

  private constructor(child: ChildProcess, ws: globalThis.WebSocket) {
    this.#child = child;
    this.#ws = ws;
  }

  static async launch(profileDir: string): Promise<HeadlessBrowser> {
    const executable = findInstalledChromium();
    assert.ok(executable, "expected Chromium executable to be installed");
    await mkdir(profileDir, { recursive: true });
    const child = spawn(
      executable,
      [
        "--headless=new",
        ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []),
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );

    const portFile = path.join(profileDir, "DevToolsActivePort");
    const wsUrl = await until(async () => {
      try {
        const raw = await readFile(portFile, "utf8");
        const [portLine, pathLine] = raw.split(/\r?\n/).map((s) => s.trim());
        const port = Number(portLine);
        if (port > 0 && pathLine?.startsWith("/devtools/browser/")) {
          return `ws://127.0.0.1:${port}${pathLine}`;
        }
      } catch {
        // still starting
      }
      if (child.exitCode !== null) {
        throw new Error(`Chromium exited unexpectedly: ${child.exitCode}`);
      }
      return null;
    }, 15_000, "DevToolsActivePort");

    const ws = new globalThis.WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP WS failed")), { once: true });
    });

    const browser = new HeadlessBrowser(child, ws);
    await browser.#init();
    return browser;
  }

  async #init(): Promise<void> {
    this.#ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as Record<string, any>;
      if (msg.id && this.#pending.has(msg.id)) {
        const entry = this.#pending.get(msg.id)!;
        this.#pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        } else {
          entry.resolve(msg.result);
        }
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.exceptions.push(JSON.stringify(msg.params));
      } else if (
        msg.method === "Runtime.consoleAPICalled" &&
        msg.params?.type === "error"
      ) {
        this.consoleErrors.push(JSON.stringify(msg.params));
      }
    });

    const { targetInfos } = (await this.#send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string }>;
    };
    const pageTarget =
      targetInfos.find((t) => t.type === "page") ??
      ((await this.#send("Target.createTarget", { url: "about:blank" })) as { targetId: string });
    const { sessionId } = (await this.#send("Target.attachToTarget", {
      targetId: pageTarget.targetId,
      flatten: true,
    })) as { sessionId: string };
    this.#sessionId = sessionId;
    await this.#pageSend("Page.enable");
    await this.#pageSend("Runtime.enable");
  }

  #send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<any> {
    const id = this.#nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  #pageSend(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return this.#send(method, params, this.#sessionId);
  }

  async setViewport(width: number, height: number, mobile: boolean): Promise<void> {
    await this.#pageSend("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: mobile ? 2 : 1,
      mobile,
    });
  }

  async navigate(url: string): Promise<void> {
    await this.#pageSend("Page.navigate", { url });
    await until(
      () => this.eval<boolean>("document.readyState === 'complete'"),
      10_000,
      "document readyState",
    );
  }

  async eval<T>(expression: string): Promise<T> {
    const res = (await this.#pageSend("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { exceptionDetails?: unknown; result?: { value: T } };
    if (res.exceptionDetails) {
      throw new Error(`Page eval failed: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value as T;
  }

  async close(): Promise<void> {
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
    if (this.#child.exitCode === null) {
      if (process.platform === "win32" && typeof this.#child.pid === "number") {
        const killer = spawn(
          "taskkill.exe",
          ["/PID", String(this.#child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        await Promise.race([
          once(killer, "exit").catch(() => {}),
          new Promise((r) => setTimeout(r, 3_000)),
        ]);
      } else {
        this.#child.kill("SIGKILL");
      }
      await Promise.race([
        once(this.#child, "exit").catch(() => {}),
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
    }
  }
}

async function connectMcpClient(url: string, token: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as never);
  return client;
}

function spawnTetherd(options: {
  tetherdPath: string;
  repoRoot: string;
  deviceWsUrl: string;
  deviceId: string;
  credentialFile: string;
  allowedRoot: string;
  stateDir: string;
  browserBridgeAddress: string;
  browserBridgeTokenFile: string;
}): { child: ChildProcess; stderr: string[] } {
  const stderr: string[] = [];
  const child = spawn(
    options.tetherdPath,
    [
      "--relay-url",
      options.deviceWsUrl,
      "--relay-allow-insecure-localhost",
      "--device-id",
      options.deviceId,
      "--device-credential-file",
      options.credentialFile,
      "--allow",
      options.allowedRoot,
      "--state-dir",
      options.stateDir,
      "--browser-bridge",
      options.browserBridgeAddress,
      "--browser-bridge-token-file",
      options.browserBridgeTokenFile,
    ],
    {
      cwd: options.repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  return { child, stderr };
}

function platformEchoArgs(text: string): { program: string; args: string[] } {
  return process.platform === "win32"
    ? { program: "cmd.exe", args: ["/C", `echo ${text}`] }
    : { program: "/bin/sh", args: ["-c", `echo ${text}`] };
}

test(
  "end-to-end live portal workflow with real tetherd, swappable browser bridge, Chromium desktop & mobile viewports",
  { timeout: 90_000 },
  async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..", "..");
    const tetherdPath = path.join(
      repoRoot,
      "target",
      "debug",
      process.platform === "win32" ? "tetherd.exe" : "tetherd",
    );

    const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-portal-control-e2e-"));
    const allowedRoot = path.join(temp, "allowed");
    const stateDir = path.join(temp, "agent-state");
    const relayState = path.join(temp, "relay-devices.json");
    const credFile = path.join(temp, "device-credential.txt");
    const bridgeTokenFile = path.join(temp, "bridge-token.txt");

    const ownerToken = "portal-control-owner-token";
    const helperToken = "portal-control-helper-token";
    const rogueToken = "portal-control-rogue-token";
    const lenoSecret = "leno-control-e2e-device-secret-32chars";
    const surfaceSecret = "surface-control-e2e-device-secret-32c";
    const bridgeToken = "portal-control-bridge-token";

    await mkdir(allowedRoot, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(credFile, lenoSecret, "utf8");
    await writeFile(bridgeTokenFile, bridgeToken, "utf8");

    const swappable = new HotSwappableBrowserBackend();
    const bridge = await startBrowserRpcServer({
      service: new BrowserBridgeService({ backend: swappable }),
      token: bridgeToken,
    });

    const relay = await RelayServer.create({
      stateFile: relayState,
      allowInsecureLocalhost: true,
      routeTimeoutMs: 4_000,
      authenticator: new StaticClientAuthenticator([
        {
          token: ownerToken,
          accountId: "account-a",
          clientId: "owner-client-a",
          principalId: "human:account-a",
        },
        {
          token: helperToken,
          accountId: "account-a",
          clientId: "helper-client-a",
          principalId: "operator:helper",
        },
        {
          token: rogueToken,
          accountId: "account-a",
          clientId: "rogue-client-a",
          principalId: "operator:rogue",
        },
      ]),
    });
    const address = await relay.listen({ host: "127.0.0.1", port: 0 });

    let tetherdProc: { child: ChildProcess; stderr: string[] } | null = null;
    let browser: HeadlessBrowser | null = null;
    let ownerClient: Client | null = null;
    let helperClient: Client | null = null;
    let rogueClient: Client | null = null;

    try {
      // Pair two devices: Leno (will run live tetherd) & Surface (stays offline)
      for (const [deviceId, secret] of [
        ["Leno", lenoSecret],
        ["Surface", surfaceSecret],
      ] as const) {
        const start = await fetch(`${address.httpUrl}/pair/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceId,
            credentialHash: hashDeviceCredential(secret),
          }),
        }).then((r) => r.json() as Promise<{ userCode: string }>);
        const app = await fetch(`${address.httpUrl}/pair/approve`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${ownerToken}`,
          },
          body: JSON.stringify({ userCode: start.userCode }),
        });
        assert.equal(app.status, 200);
      }

      tetherdProc = spawnTetherd({
        tetherdPath,
        repoRoot,
        deviceWsUrl: address.deviceWsUrl,
        deviceId: "Leno",
        credentialFile: credFile,
        allowedRoot,
        stateDir,
        browserBridgeAddress: bridge.address,
        browserBridgeTokenFile: bridgeTokenFile,
      });

      await until(() => relay.router.isOnline("Leno"), 10_000, "Leno tetherd online");

      ownerClient = await connectMcpClient(address.mcpUrl, ownerToken, "owner");
      helperClient = await connectMcpClient(address.mcpUrl, helperToken, "helper");
      rogueClient = await connectMcpClient(address.mcpUrl, rogueToken, "rogue");

      // Launch Chromium at desktop resolution and connect to Portal
      browser = await HeadlessBrowser.launch(path.join(temp, "chromium-profile"));
      await browser.setViewport(1280, 800, false);
      await browser.navigate(`${address.httpUrl}/portal`);

      await browser.eval(`(() => {
        document.getElementById("token-input").value = ${JSON.stringify(ownerToken)};
        document.getElementById("connect-btn").click();
      })()`);

      await until(
        () =>
          browser!.eval<boolean>(
            `document.querySelector('[data-sync-badge="Leno"]')?.textContent === "Confirmed Active (v1)" && document.querySelectorAll(".device-card").length === 2`,
          ),
        12_000,
        "Leno Confirmed Active (v1) and Surface rendered",
      );

      // Verify desktop zero horizontal overflow and standby browser status
      const desktopInitial = await browser.eval<{
        scrollWidth: number;
        innerWidth: number;
        lenoBrowserSub: string;
      }>(`(() => {
        const leno = document.querySelector('.device-card[data-device-id="Leno"]');
        const browserToggle = leno.querySelector('[data-action="toggle-family"][data-family="browser"]').closest('.family-toggle');
        return {
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          lenoBrowserSub: browserToggle.querySelector('.family-sub').textContent,
        };
      })()`);
      assert.ok(
        desktopInitial.scrollWidth <= desktopInitial.innerWidth,
        `Desktop overflow: ${desktopInitial.scrollWidth} > ${desktopInitial.innerWidth}`,
      );
      assert.match(desktopInitial.lenoBrowserSub, /Unavailable/);

      // Unregistered operator is denied even on files.read
      const rogueRes = await rogueClient.callTool({
        name: "files",
        arguments: { op: "list", device: "Leno", args: { path: allowedRoot } },
      });
      assert.equal(rogueRes.isError, true);

      // Owner works on universal default
      const targetFile = path.join(allowedRoot, "portal-e2e.txt");
      const ownerWrite = await ownerClient.callTool({
        name: "files",
        arguments: {
          op: "write",
          device: "Leno",
          args: { path: targetFile, content: "hello-tetherplane\n" },
        },
      });
      assert.equal(ownerWrite.isError, undefined);

      // Attach live browser backend -> tetherd probes & emits device_telemetry -> SSE updates UI live without Refresh
      swappable.attach(new LiveFakeBrowserBackend());
      await until(
        () =>
          browser!.eval<boolean>(`(() => {
            const leno = document.querySelector('.device-card[data-device-id="Leno"]');
            const sub = leno?.querySelector('[data-action="toggle-family"][data-family="browser"]')?.closest('.family-toggle')?.querySelector('.family-sub')?.textContent || "";
            return sub.includes("ops active") && !sub.startsWith("0/");
          })()`),
        10_000,
        "live browser recovery reflected via device_telemetry + SSE",
      );

      const pagesRes = await ownerClient.callTool({
        name: "browser",
        arguments: { op: "pages", device: "Leno", args: {} },
      });
      assert.equal(pagesRes.isError, undefined);

      // Toggle process OFF via UI & verify MCP enforcement + live ACK v2
      await browser.eval(`(() => {
        const leno = document.querySelector('.device-card[data-device-id="Leno"]');
        leno.querySelector('[data-action="toggle-family"][data-family="process"]').click();
      })()`);
      await until(
        () =>
          browser!.eval<boolean>(
            `document.querySelector('[data-sync-badge="Leno"]')?.textContent === "Confirmed Active (v2)"`,
          ),
        8_000,
        "Leno v2 Confirmed Active after toggling process off",
      );
      const deniedProc = await ownerClient.callTool({
        name: "process",
        arguments: { op: "run", device: "Leno", args: platformEchoArgs("no") },
      });
      assert.equal(deniedProc.isError, true);
      await until(
        () => browser!.eval<boolean>(
          `Boolean(document.querySelector('#toast-stack .toast[data-kind="policy-confirmed"]')?.textContent?.includes('confirmed by device'))`,
        ),
        8_000,
        "permission revoke shows device-confirmed notification",
      );

      // Select ONLY Leno via per-device checkbox and assign operator:helper read_only -> scoped ONLY to Leno!
      await browser.eval(`(() => {
        const cb = document.querySelector('[data-action="select-device"][data-device="Leno"]');
        cb.click();
        const details = document.getElementById("operator-advanced-box");
        if (details) details.open = true;
        document.getElementById("op-principal-id").value = "operator:helper";
        document.getElementById("op-display-name").value = "CI Helper";
        document.getElementById("op-profile-id").value = "read_only";
        document.getElementById("save-operator-btn").click();
      })()`);
      await until(
        () =>
          browser!.eval<boolean>(
            `Boolean(document.querySelector('[data-action="remove-operator"][data-principal="operator:helper"]')) && document.querySelector('[data-sync-badge="Leno"]')?.textContent === "Confirmed Active (v3)"`,
          ),
        8_000,
        "operator:helper scoped UI row and Leno v3 ACK",
      );

      // Verify Surface was untouched by Leno-only operator assignment and Edit Operator UX works
      const scopedOpCheck = await browser.eval<{
        surfaceBadge: string;
        identitiesText: string;
        targetBadge: string;
        reopenedOpen: boolean;
        prefilledId: string;
        prefilledName: string;
        prefilledProfile: string;
        lenoReChecked: boolean;
      }>(`(() => {
        const surfaceBadge = document.querySelector('[data-sync-badge="Surface"]')?.textContent || "";
        const identitiesText = document.getElementById("identities-container")?.textContent || "";
        const targetBadge = document.getElementById("global-target-badge")?.textContent || "";
        document.getElementById("clear-selected-devices-btn").click();
        const details = document.getElementById("operator-advanced-box");
        details.open = false;
        document.getElementById("op-principal-id").value = "";
        document.getElementById("op-display-name").value = "";
        document.querySelector('[data-action="edit-operator"][data-principal="operator:helper"]').click();
        return {
          surfaceBadge,
          identitiesText,
          targetBadge,
          reopenedOpen: details.open,
          prefilledId: document.getElementById("op-principal-id").value,
          prefilledName: document.getElementById("op-display-name").value,
          prefilledProfile: document.getElementById("op-profile-id").value,
          lenoReChecked: document.querySelector('[data-action="select-device"][data-device="Leno"]').checked,
        };
      })()`);
      assert.equal(scopedOpCheck.surfaceBadge, "Pending Device Ack (v1)");
      assert.match(scopedOpCheck.identitiesText, /Leno \(read_only\)/);
      assert.doesNotMatch(scopedOpCheck.identitiesText, /Surface \(read_only\)/);
      assert.match(scopedOpCheck.targetBadge, /1 selected \(Leno\)/);
      assert.equal(scopedOpCheck.reopenedOpen, true);
      assert.equal(scopedOpCheck.prefilledId, "operator:helper");
      assert.equal(scopedOpCheck.prefilledName, "CI Helper");
      assert.equal(scopedOpCheck.prefilledProfile, "read_only");
      assert.equal(scopedOpCheck.lenoReChecked, true);

      // Helper succeeds reading file on Leno, fails writing on Leno
      const helperRead = await helperClient.callTool({
        name: "files",
        arguments: { op: "read", device: "Leno", args: { path: targetFile } },
      });
      assert.equal(helperRead.isError, undefined);
      const helperWrite = await helperClient.callTool({
        name: "files",
        arguments: {
          op: "write",
          device: "Leno",
          args: { path: targetFile, content: "mutated" },
        },
      });
      assert.equal(helperWrite.isError, true);

      // Revoke an ACTIVE operator grant and require an actual device acknowledgment
      await browser.eval(
        `document.querySelector('[data-action="remove-operator"][data-principal="operator:helper"]').click()`,
      );
      await until(
        () =>
          browser!.eval<boolean>(
            `!document.querySelector('[data-action="remove-operator"][data-principal="operator:helper"]')`,
          ),
        8_000,
        "operator:helper removed from UI",
      );
      const helperAfterRemove = await helperClient.callTool({
        name: "files",
        arguments: { op: "read", device: "Leno", args: { path: targetFile } },
      });
      assert.equal(helperAfterRemove.isError, true);
      await until(
        () => browser!.eval<boolean>(
          `Boolean(document.querySelector('#toast-stack .toast[data-kind="policy-confirmed"]')?.textContent?.includes('Revoke operator access confirmed by device'))`,
        ),
        8_000,
        "operator access removal confirmed by Leno device",
      );

      // Clear selection and create extra revisions on Leno (>11 total) to verify Snapshot Filter + Pagination + Rollback
      await browser.eval(`document.getElementById("clear-selected-devices-btn").click()`);
      for (let i = 0; i < 9; i += 1) {
        const res = await fetch(`${address.httpUrl}/portal/api/devices/Leno/policy`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${ownerToken}`,
          },
          body: JSON.stringify({
            grantFamilies: i % 2 === 0 ? ["files"] : [],
            revokeFamilies: i % 2 === 1 ? ["files"] : [],
            reason: `Batch snapshot step ${i}`,
          }),
        });
        assert.equal(res.status, 200);
      }

      // Open snapshots box, filter by Leno, click "Show more snapshots" to reveal rev 1, and rollback to rev 1
      await browser.eval(`(() => {
        const box = document.getElementById("snapshots-advanced-box");
        box.open = true;
        const select = document.getElementById("snapshot-device-filter");
        select.value = "Leno";
        select.dispatchEvent(new Event("change"));
      })()`);
      await until(
        () =>
          browser!.eval<boolean>(
            `Boolean(document.getElementById("snapshots-more-btn"))`,
          ),
        8_000,
        "Show more snapshots pagination button",
      );
      await browser.eval(`document.getElementById("snapshots-more-btn").click()`);
      await until(
        () =>
          browser!.eval<boolean>(
            `Boolean(document.querySelector('[data-action="rollback"][data-device="Leno"][data-rev="1"]'))`,
          ),
        5_000,
        "Leno rev 1 rollback button after pagination",
      );
      await browser.eval(
        `document.querySelector('[data-action="rollback"][data-device="Leno"][data-rev="1"]').click()`,
      );
      await until(
        () =>
          browser!.eval<boolean>(
            `document.querySelector('[data-sync-badge="Leno"]')?.textContent === "Confirmed Active (v14)"`,
          ),
        8_000,
        "Leno rollback synced as Confirmed Active (v14)",
      );

      // Process execution should now succeed again after rollback to universal v1
      const restoredProc = await ownerClient.callTool({
        name: "process",
        arguments: { op: "run", device: "Leno", args: platformEchoArgs("rolled-back") },
      });
      assert.equal(restoredProc.isError, undefined);
      await until(
        () => browser!.eval<boolean>(
          `Boolean(document.querySelector('#toast-stack .toast[data-kind="policy-confirmed"]')?.textContent?.includes('Rollback to revision 1 confirmed by device'))`,
        ),
        8_000,
        "grant recovery rollback shows confirmed device notification",
      );

      // Emergency Access Revocation -> Lift Lockdown button recovers Leno!
      await browser.eval(`(() => {
        document.getElementById("emergency-revoke-btn").click();
        document.getElementById("modal-reason").value = "E2E emergency drill";
        document.getElementById("modal-confirm-btn").click();
      })()`);
      await until(
        () =>
          browser!.eval<boolean>(
            `document.querySelector('[data-sync-badge="Leno"]')?.textContent === "Emergency Lockdown" && Boolean(document.querySelector('[data-action="lift-lockdown"][data-device="Leno"]'))`,
          ),
        8_000,
        "Emergency Lockdown badge and per-device Lift Lockdown button",
      );
      const lockedRead = await ownerClient.callTool({
        name: "files",
        arguments: { op: "read", device: "Leno", args: { path: targetFile } },
      });
      assert.equal(lockedRead.isError, true);

      await browser.eval(
        `document.querySelector('[data-action="lift-lockdown"][data-device="Leno"]').click()`,
      );
      await until(
        () =>
          browser!.eval<boolean>(
            `document.querySelector('[data-sync-badge="Leno"]')?.textContent === "Confirmed Active (v16)"`,
          ),
        8_000,
        "Lift Lockdown restored Confirmed Active (v16)",
      );
      const restoredRead = await ownerClient.callTool({
        name: "files",
        arguments: { op: "read", device: "Leno", args: { path: targetFile } },
      });
      assert.equal(restoredRead.isError, undefined);

      // Surface is still locked down -> scope Global Lift Lockdown ONLY to Surface and confirm security returns Active without altering Leno v16
      await browser.eval(`(() => {
        document.querySelector('[data-action="select-device"][data-device="Surface"]').click();
        document.getElementById("global-lift-lockdown-btn").click();
        document.getElementById("modal-reason").value = "Lift Surface lockdown";
        document.getElementById("modal-confirm-btn").click();
      })()`);
      await until(
        () =>
          browser!.eval<boolean>(
            `document.getElementById("stat-security")?.textContent === "Active" && document.getElementById("global-lift-lockdown-btn").classList.contains("hidden")`,
          ),
        8_000,
        "Scoped Global Lift Lockdown restored Active status for Surface",
      );
      await browser.eval(`document.getElementById("clear-selected-devices-btn").click()`);
      assert.equal(
        await browser.eval<string>(`document.querySelector('[data-sync-badge="Leno"]')?.textContent`),
        "Confirmed Active (v16)",
      );

      // Switch to mobile viewport (390x844) and test offline update -> tetherd reconnect resync + layout
      await browser.setViewport(390, 844, true);
      tetherdProc.child.kill();
      await once(tetherdProc.child, "exit");

      await until(
        () =>
          browser!.eval<boolean>(
            `document.querySelector('.device-card[data-device-id="Leno"] .pill.offline')?.textContent === "Offline"`,
          ),
        8_000,
        "Leno Offline pill in mobile view via SSE",
      );

      // Toggle process OFF while Leno is offline -> stays Pending Device Ack
      await browser.eval(
        `document.querySelector('.device-card[data-device-id="Leno"] [data-action="toggle-family"][data-family="process"]').click()`,
      );
      await until(
        () =>
          browser!.eval<boolean>(
            `document.querySelector('[data-sync-badge="Leno"]')?.textContent === "Pending Device Ack (v17)"`,
          ),
        8_000,
        "Pending Device Ack (v17) while offline",
      );

      // Restart tetherd from persisted stateDir -> reconnects, syncs v17, and transitions mobile UI live to Confirmed Active (v17)
      tetherdProc = spawnTetherd({
        tetherdPath,
        repoRoot,
        deviceWsUrl: address.deviceWsUrl,
        deviceId: "Leno",
        credentialFile: credFile,
        allowedRoot,
        stateDir,
        browserBridgeAddress: bridge.address,
        browserBridgeTokenFile: bridgeTokenFile,
      });
      await until(
        () =>
          browser!.eval<boolean>(
            `document.querySelector('[data-sync-badge="Leno"]')?.textContent === "Confirmed Active (v17)"`,
          ),
        12_000,
        "Leno reconnect sync Confirmed Active (v17) in mobile viewport",
      );

      // Verify offline revocation synced to reconnected tetherd
      const procAfterReconnect = await ownerClient.callTool({
        name: "process",
        arguments: { op: "run", device: "Leno", args: platformEchoArgs("denied") },
      });
      assert.equal(procAfterReconnect.isError, true);

      const mobileLayout = await browser.eval<{
        scrollWidth: number;
        innerWidth: number;
      }>("({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })");
      assert.ok(
        mobileLayout.scrollWidth <= mobileLayout.innerWidth,
        `Mobile horizontal overflow: ${mobileLayout.scrollWidth} > ${mobileLayout.innerWidth}`,
      );

      assert.deepEqual(browser.exceptions, []);
      assert.deepEqual(browser.consoleErrors, []);
    } finally {
      await ownerClient?.close().catch(() => {});
      await helperClient?.close().catch(() => {});
      await rogueClient?.close().catch(() => {});
      await browser?.close();
      if (tetherdProc && tetherdProc.child.exitCode === null) {
        tetherdProc.child.kill();
        await Promise.race([
          once(tetherdProc.child, "exit").catch(() => {}),
          new Promise((r) => setTimeout(r, 3_000)),
        ]);
      }
      await bridge.close();
      await relay.close();
      await rm(temp, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      });
    }
  },
);
