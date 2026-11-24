import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findInstalledChromium } from "@tetherplane/browser-bridge";
import {
  ALL_TOOL_FAMILIES,
  CANONICAL_OPERATIONS_BY_FAMILY,
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "@tetherplane/relay";

async function until<T>(
  predicate: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs = 10_000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class RawDeviceWs {
  readonly #socket: import("node:net").Socket;

  private constructor(socket: import("node:net").Socket) {
    this.#socket = socket;
  }

  static async connect(
    wsUrl: string,
    headers: Record<string, string>,
  ): Promise<RawDeviceWs> {
    const url = new URL(wsUrl);
    const key = randomBytes(16).toString("base64");
    return await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          ...headers,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": key,
        },
      });
      req.once("upgrade", (_res, socket) => {
        resolve(new RawDeviceWs(socket));
      });
      req.once("response", (res) => {
        reject(new Error(`Unexpected HTTP status on WS upgrade: ${res.statusCode}`));
      });
      req.once("error", reject);
      req.end();
    });
  }

  sendJson(payload: unknown): void {
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    const mask = randomBytes(4);
    const headerParts: Buffer[] = [];
    if (data.length < 126) {
      headerParts.push(Buffer.from([0x81, 0x80 | data.length]));
    } else if (data.length < 65536) {
      const buf = Buffer.alloc(4);
      buf[0] = 0x81;
      buf[1] = 0x80 | 126;
      buf.writeUInt16BE(data.length, 2);
      headerParts.push(buf);
    } else {
      throw new Error("payload too large for test frame helper");
    }
    const masked = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i += 1) {
      masked[i] = data[i]! ^ mask[i % 4]!;
    }
    this.#socket.write(Buffer.concat([...headerParts, mask, masked]));
  }

  close(): void {
    this.#socket.destroy();
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
        // Still starting
      }
      if (child.exitCode !== null) {
        throw new Error(`Chromium exited unexpectedly: ${child.exitCode}`);
      }
      return null;
    }, 15_000, "DevToolsActivePort");

    const ws = new globalThis.WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP WS failed")), {
        once: true,
      });
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
      ((await this.#send("Target.createTarget", { url: "about:blank" })) as {
        targetId: string;
      });
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
    const payload = sessionId
      ? { id, method, params, sessionId }
      : { id, method, params };
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  #pageSend(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<any> {
    return this.#send(method, params, this.#sessionId);
  }

  async setViewport(width: number, height: number, mobile = false): Promise<void> {
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
    })) as {
      exceptionDetails?: unknown;
      result?: { value: T };
    };
    if (res.exceptionDetails) {
      throw new Error(`Page eval failed: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value as T;
  }

  async dispatchKey(key: string): Promise<void> {
    await this.#pageSend("Input.dispatchKeyEvent", { type: "keyDown", key });
    await this.#pageSend("Input.dispatchKeyEvent", { type: "keyUp", key });
  }

  async close(): Promise<void> {
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
    if (this.#child.exitCode === null) {
      this.#child.kill("SIGKILL");
      await Promise.race([
        once(this.#child, "exit").catch(() => {}),
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
    }
  }
}

function fullCapabilities(): Record<string, unknown> {
  const toolFamilies: Record<string, unknown> = {};
  for (const family of ALL_TOOL_FAMILIES) {
    toolFamilies[family] = {
      available: true,
      provider_available: true,
      available_operations: [...CANONICAL_OPERATIONS_BY_FAMILY[family]],
    };
  }
  return { providers: [], tool_families: toolFamilies };
}

async function pairDevice(
  httpUrl: string,
  ownerToken: string,
  deviceId: string,
  secret: string,
): Promise<void> {
  const start = (await fetch(`${httpUrl}/pair/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId,
      credentialHash: hashDeviceCredential(secret),
    }),
  }).then((r) => r.json())) as { userCode: string };
  const approve = await fetch(`${httpUrl}/pair/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ userCode: start.userCode }),
  });
  assert.equal(approve.status, 200);
}

test("owner portal usability: clean signed-in header, relay-pending vs device-confirmed states, partial toggles, denied chips, fleet filters, modal Escape, and mobile ergonomics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-portal-ux-e2e-"));
  const ownerToken = "owner-portal-usability-test-token";
  const relay = await RelayServer.create({
    authenticator: new StaticClientAuthenticator([
      {
        token: ownerToken,
        accountId: "acct-ux",
        clientId: "portal-ux-client",
        principalId: "human:acct-ux",
        role: "owner",
      },
    ]),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  const sockets: RawDeviceWs[] = [];
  let browser: HeadlessBrowser | null = null;

  try {
    await pairDevice(address.httpUrl, ownerToken, "Node-Online", "secret-online-node-123456789012");
    await pairDevice(address.httpUrl, ownerToken, "Node-ReadOnly", "secret-readonly-node-1234567890");
    await pairDevice(address.httpUrl, ownerToken, "Node-Offline", "secret-offline-node-12345678901");

    const onlineWs = await RawDeviceWs.connect(address.deviceWsUrl, {
      authorization: "Device secret-online-node-123456789012",
      "x-tetherplane-device-id": "Node-Online",
    });
    sockets.push(onlineWs);
    onlineWs.sendJson({
      type: "device_hello",
      deviceId: "Node-Online",
      appliedPolicyRevision: 1,
      status: { os: "windows", arch: "x86_64", agent_version: "0.1.0", policy_mode: "background_only" },
      capabilities: fullCapabilities(),
    });

    const roWs = await RawDeviceWs.connect(address.deviceWsUrl, {
      authorization: "Device secret-readonly-node-1234567890",
      "x-tetherplane-device-id": "Node-ReadOnly",
    });
    sockets.push(roWs);
    roWs.sendJson({
      type: "device_hello",
      deviceId: "Node-ReadOnly",
      appliedPolicyRevision: 1,
      status: { os: "linux", arch: "x86_64", agent_version: "0.1.0", policy_mode: "background_only" },
      capabilities: fullCapabilities(),
    });

    // Apply read_only to Node-ReadOnly and confirm it
    const roRes = await fetch(`${address.httpUrl}/portal/api/devices/Node-ReadOnly/policy`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ profileId: "read_only", reason: "Initial read-only" }),
    });
    assert.equal(roRes.status, 200);
    roWs.sendJson({
      type: "policy_ack",
      deviceId: "Node-ReadOnly",
      revision: 2,
      currentRevision: 2,
      applied: true,
      appliedAtMs: Date.now(),
      capabilities: fullCapabilities(),
    });

    await until(async () => {
      const ov = (await fetch(`${address.httpUrl}/portal/api/overview`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }).then((r) => r.json())) as {
        devices: Array<{ deviceId: string; online: boolean; confirmedByDevice: boolean; appliedRevision: number }>;
      };
      const a = ov.devices.find((d) => d.deviceId === "Node-Online");
      const b = ov.devices.find((d) => d.deviceId === "Node-ReadOnly");
      return Boolean(a?.online && a?.confirmedByDevice && b?.online && b?.appliedRevision === 2);
    }, 5_000, "initial synthetic devices confirmed");

    browser = await HeadlessBrowser.launch(path.join(dir, "chrome"));
    await browser.setViewport(1280, 860, false);
    await browser.navigate(`${address.httpUrl}/portal`);

    // Signed-out state: token input & connect button visible
    const signedOutUi = await browser.eval<{
      authAttr: string;
      tokenVisible: boolean;
      connectVisible: boolean;
      navHidden: boolean;
    }>(`(() => ({
      authAttr: document.body.dataset.auth || "",
      tokenVisible: getComputedStyle(document.getElementById("token-input")).display !== "none",
      connectVisible: getComputedStyle(document.getElementById("connect-btn")).display !== "none",
      navHidden: getComputedStyle(document.querySelector(".owner-nav")).display === "none",
    }))()`);
    assert.equal(signedOutUi.authAttr, "signed-out");
    assert.equal(signedOutUi.tokenVisible, true);
    assert.equal(signedOutUi.connectVisible, true);
    assert.equal(signedOutUi.navHidden, true, "signed-out owner navigation must be hidden");

    // Sign in
    await browser.eval(`(() => {
      document.getElementById("token-input").value = ${JSON.stringify(ownerToken)};
      document.getElementById("connect-btn").click();
    })()`);
    await until(
      () => browser!.eval<boolean>("document.querySelectorAll('.device-card').length === 3"),
      10_000,
      "3 device cards rendered",
    );

    // Signed-in state: token input & connect button hidden; live SSE indicator & canonical datalist present
    const signedInUi = await browser.eval<{
      authAttr: string;
      tokenHidden: boolean;
      connectHidden: boolean;
      datalistCount: number;
      roFilesSwitchText: string;
      roProcessSwitchText: string;
      offlineSyncDetail: string;
      offlineBrowserLabel: string;
      offlineBrowserClass: string;
      offlineBrowserSubtitle: string;
      navTargets: string[];
      navVisible: boolean;
    }>(`(() => {
      const roCard = document.querySelector('.device-card[data-device-id="Node-ReadOnly"]');
      const roFilesBtn = roCard.querySelector('[data-action="toggle-family"][data-family="files"]');
      const roProcBtn = roCard.querySelector('[data-action="toggle-family"][data-family="process"]');
      const offDetail = document.querySelector('[data-sync-detail="Node-Offline"]')?.textContent || "";
      const offBrowser = document.querySelector('.device-card[data-device-id="Node-Offline"] [data-action="toggle-family"][data-family="browser"]');
      return {
        authAttr: document.body.dataset.auth || "",
        tokenHidden: getComputedStyle(document.getElementById("token-input")).display === "none",
        connectHidden: getComputedStyle(document.getElementById("connect-btn")).display === "none",
        datalistCount: document.querySelectorAll("#canonical-ops-list option").length,
        roFilesSwitchText: roFilesBtn?.textContent || "",
        roProcessSwitchText: roProcBtn?.textContent || "",
        offlineSyncDetail: offDetail,
        offlineBrowserLabel: offBrowser?.textContent || "",
        offlineBrowserClass: offBrowser?.className || "",
        offlineBrowserSubtitle: offBrowser?.closest(".family-toggle")?.querySelector(".family-sub")?.textContent || "",
        navTargets: Array.from(document.querySelectorAll(".owner-nav a")).map((link) => link.getAttribute("href")),
        navVisible: getComputedStyle(document.querySelector(".owner-nav")).display !== "none",
      };
    })()`);
    assert.equal(signedInUi.authAttr, "signed-in");
    assert.equal(signedInUi.tokenHidden, true);
    assert.equal(signedInUi.connectHidden, true);
    assert.equal(signedInUi.navVisible, true);
    assert.deepEqual(signedInUi.navTargets, ["#devices-container", "#global-controls", "#owner-identities", "#security-audit"]);
    assert.ok(signedInUi.datalistCount >= 30, "expected canonical ops datalist options");
    assert.equal(signedInUi.roFilesSwitchText, "PARTIAL");
    assert.equal(signedInUi.roProcessSwitchText, "OFF");
    assert.match(signedInUi.offlineSyncDetail, /Relay queued v1.*offline/i);
    assert.equal(signedInUi.offlineBrowserLabel, "CONFIGURED", "offline policy must not appear live ON");
    assert.match(signedInUi.offlineBrowserClass, /configured/);
    assert.match(signedInUi.offlineBrowserSubtitle, /not currently active/i);

    // Relay-accepted Pending vs Device-Confirmed Enforcement transition on Node-Online
    await browser.eval(`(() => {
      const card = document.querySelector('.device-card[data-device-id="Node-Online"]');
      card.querySelector('[data-action="toggle-family"][data-family="process"]').click();
    })()`);
    await until(
      () =>
        browser!.eval<boolean>(
          `document.querySelector('[data-sync-badge="Node-Online"]')?.textContent === "Pending Device Ack (v2)"`,
        ),
      5_000,
      "Node-Online Pending Device Ack (v2)",
    );
    const pendingState = await browser.eval<{
      syncDetail: string;
      pendingToastCount: number;
      confirmedToastCount: number;
    }>(`(() => ({
      syncDetail: document.querySelector('[data-sync-detail="Node-Online"]')?.textContent || "",
      pendingToastCount: document.querySelectorAll('#toast-stack .toast[data-kind="policy-pending"]').length,
      confirmedToastCount: document.querySelectorAll('#toast-stack .toast[data-kind="policy-confirmed"]').length,
    }))()`);
    assert.match(pendingState.syncDetail, /Relay accepted v2.*waiting for device confirmation/i);
    assert.equal(pendingState.pendingToastCount, 1);
    assert.equal(pendingState.confirmedToastCount, 0);

    // Device sends policy_ack -> SSE confirms, updates detail, and clears stale pending toast!
    onlineWs.sendJson({
      type: "policy_ack",
      deviceId: "Node-Online",
      revision: 2,
      currentRevision: 2,
      applied: true,
      appliedAtMs: Date.now(),
      capabilities: fullCapabilities(),
    });
    await until(
      () =>
        browser!.eval<boolean>(
          `document.querySelector('[data-sync-badge="Node-Online"]')?.textContent === "Confirmed Active (v2)"`,
        ),
      5_000,
      "Node-Online Confirmed Active (v2)",
    );
    const confirmedState = await browser.eval<{
      syncDetail: string;
      pendingToastCount: number;
      confirmedToastText: string;
    }>(`(() => ({
      syncDetail: document.querySelector('[data-sync-detail="Node-Online"]')?.textContent || "",
      pendingToastCount: document.querySelectorAll('#toast-stack .toast[data-kind="policy-pending"]').length,
      confirmedToastText: document.querySelector('#toast-stack .toast[data-kind="policy-confirmed"]')?.textContent || "",
    }))()`);
    assert.match(confirmedState.syncDetail, /Device confirmed v2/i);
    assert.equal(confirmedState.pendingToastCount, 0, "resolved pending toast should clear");
    assert.match(confirmedState.confirmedToastText, /confirmed by device/i);

    // Explicit deny + one-tap Allow chip
    await browser.eval(`(() => {
      const card = document.querySelector('.device-card[data-device-id="Node-Online"]');
      card.querySelector("details.advanced-box").open = true;
      card.querySelector('[data-role="op-rule-input"]').value = "filesystem.write";
      card.querySelector('[data-action="deny-op"]').click();
    })()`);
    await until(
      () =>
        browser!.eval<boolean>(
          `Boolean(document.querySelector('[data-action="allow-denied-op"][data-device="Node-Online"][data-capability="filesystem.write"]'))`,
        ),
      5_000,
      "one-tap denied op chip rendered",
    );
    onlineWs.sendJson({
      type: "policy_ack",
      deviceId: "Node-Online",
      revision: 3,
      currentRevision: 3,
      applied: true,
      appliedAtMs: Date.now(),
      capabilities: fullCapabilities(),
    });
    await until(
      () =>
        browser!.eval<boolean>(
          `document.querySelector('[data-sync-badge="Node-Online"]')?.textContent === "Confirmed Active (v3)"`,
        ),
      5_000,
      "Node-Online v3 confirmed",
    );

    // Click one-tap Allow chip to remove explicit deny
    await browser.eval(
      `document.querySelector('[data-action="allow-denied-op"][data-device="Node-Online"][data-capability="filesystem.write"]').click()`,
    );
    await until(
      () =>
        browser!.eval<boolean>(
          `!document.querySelector('[data-action="allow-denied-op"][data-device="Node-Online"][data-capability="filesystem.write"]')`,
        ),
      5_000,
      "denied op chip removed after one-tap allow",
    );

    // Device rejection surfaces Sync Rejected + error detail + error toast
    onlineWs.sendJson({
      type: "policy_ack",
      deviceId: "Node-Online",
      revision: 4,
      currentRevision: 3,
      applied: false,
      error: "simulated enforcement rejection",
      appliedAtMs: Date.now(),
    });
    await until(
      () =>
        browser!.eval<boolean>(
          `document.querySelector('[data-sync-badge="Node-Online"]')?.textContent === "Sync Rejected"`,
        ),
      5_000,
      "Node-Online Sync Rejected",
    );
    const rejectedDetail = await browser.eval<string>(
      `document.querySelector('[data-sync-detail="Node-Online"]')?.textContent || ""`,
    );
    assert.match(rejectedDetail, /Device rejected v4/i);

    // Fleet quick-filter pills: Offline -> 1 card, Attention -> 2 cards (offline + rejected), All -> 3 cards
    await browser.eval(`document.querySelector('[data-action="fleet-filter"][data-filter="offline"]').click()`);
    assert.equal(await browser.eval<number>(`document.querySelectorAll(".device-card").length`), 1);
    await browser.eval(`document.querySelector('[data-action="fleet-filter"][data-filter="attention"]').click()`);
    assert.equal(await browser.eval<number>(`document.querySelectorAll(".device-card").length`), 2);
    await browser.eval(`document.querySelector('[data-action="fleet-filter"][data-filter="all"]').click()`);
    assert.equal(await browser.eval<number>(`document.querySelectorAll(".device-card").length`), 3);

    // Modal Escape key closes confirmation dialog cleanly
    await browser.eval(`document.getElementById("emergency-revoke-btn").click()`);
    assert.equal(
      await browser.eval<boolean>(`document.getElementById("confirm-modal").classList.contains("active")`),
      true,
    );
    await browser.dispatchKey("Escape");
    assert.equal(
      await browser.eval<boolean>(`document.getElementById("confirm-modal").classList.contains("active")`),
      false,
    );

    // Mobile 390x844 ergonomics: compact signed-in topbar, >=44px switches, zero horizontal overflow
    await browser.setViewport(390, 844, true);
    await new Promise((r) => setTimeout(r, 150));
    const mobileAudit = await browser.eval<{
      scrollWidth: number;
      innerWidth: number;
      topbarHeight: number;
      switchHeight: number;
      devicesTop: number;
      globalTop: number;
      imgOrSvgCount: number;
      auditText: string;
      navPosition: string;
      navLinkHeight: number;
      navLeft: number;
      navRight: number;
    }>(`(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      topbarHeight: Math.round(document.querySelector(".topbar").getBoundingClientRect().height),
      switchHeight: Math.round(document.querySelector(".switch-btn").getBoundingClientRect().height),
      devicesTop: Math.round(document.getElementById("devices-container").getBoundingClientRect().top),
      globalTop: Math.round(document.querySelector(".global-panel").getBoundingClientRect().top),
      imgOrSvgCount: document.querySelectorAll("img, svg").length,
      auditText: document.getElementById("audit-container")?.textContent || "",
      navPosition: getComputedStyle(document.querySelector(".owner-nav")).position,
      navLinkHeight: Math.round(document.querySelector(".owner-nav a").getBoundingClientRect().height),
      navLeft: Math.round(document.querySelector(".owner-nav").getBoundingClientRect().left),
      navRight: Math.round(document.querySelector(".owner-nav").getBoundingClientRect().right),
    }))()`);
    assert.ok(mobileAudit.scrollWidth <= mobileAudit.innerWidth, "mobile 390 overflow");
    assert.equal(mobileAudit.navPosition, "fixed", "mobile should have accessible persistent navigation");
    assert.ok(mobileAudit.navLinkHeight >= 44, "mobile nav touch targets must be at least 44px");
    assert.ok(mobileAudit.navLeft >= 0 && mobileAudit.navRight <= mobileAudit.innerWidth, "mobile navigation must fit viewport");
    assert.ok(mobileAudit.topbarHeight < 175, `expected compact signed-in mobile header, got ${mobileAudit.topbarHeight}px`);
    assert.ok(mobileAudit.switchHeight >= 44, `expected >=44px mobile switch height, got ${mobileAudit.switchHeight}px`);
    assert.ok(mobileAudit.devicesTop < mobileAudit.globalTop);
    assert.equal(mobileAudit.imgOrSvgCount, 0);
    assert.match(mobileAudit.auditText, /Confirmed by device/);

    // Security invariants still intact
    assert.equal(await browser.eval<number>("sessionStorage.length"), 0);
    assert.equal(await browser.eval<number>("localStorage.length"), 0);
    assert.equal(await browser.eval<string>("document.cookie"), "");
    assert.deepEqual(browser.exceptions, []);
    assert.deepEqual(browser.consoleErrors, []);
  } finally {
    await browser?.close();
    for (const s of sockets) s.close();
    await relay.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
