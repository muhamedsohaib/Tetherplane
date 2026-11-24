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

    // Verify compact disclosure and live vs configured capabilities.
    const compact = await browser.eval<{
      cards: number; closed: boolean; full: number; partial: number; offlineActive: number;
      segments: number[]; accessibleLabels: boolean; sessionClosed: boolean;
    }>(`(() => {
      const cards = [...document.querySelectorAll(".device-card")];
      const card = id => cards.find(x => x.dataset.deviceId === id);
      return {
        cards: cards.length,
        closed: cards.every(x => !x.querySelector("details.device-controls").open),
        full: card("Node-Online").querySelectorAll('[data-capability-state="full"]').length,
        partial: card("Node-ReadOnly").querySelectorAll('[data-capability-state="partial"]').length,
        offlineActive: card("Node-Offline").querySelectorAll('[data-capability-state="full"],[data-capability-state="partial"]').length,
        segments: cards.map(x => x.querySelectorAll(".capability-segment").length),
        accessibleLabels: cards.every(x => /device.*files.*process.*browser.*desktop.*batch/i.test(x.querySelector(".capability-dial").getAttribute("aria-label") || "")),
        sessionClosed: !document.querySelector(".session-menu").open
      };
    })()`);
    assert.equal(compact.cards, 3);
    assert.equal(compact.closed, true, "permission controls should be collapsed initially");
    assert.equal(compact.full, 6);
    assert.ok(compact.partial > 0);
    assert.equal(compact.offlineActive, 0);
    assert.deepEqual(compact.segments, [6,6,6]);
    assert.equal(compact.accessibleLabels, true);
    assert.equal(compact.sessionClosed, true);

    for (const [w,h,m] of [[1280,860,false],[768,1024,false],[390,844,true],[320,740,true]] as const) {
      await browser.setViewport(w,h,m);
      await browser.eval("window.scrollTo(0,0)");
      const compactLayout: {overflow:boolean; targetHeight:number; animations:number; rasterNodes:number} = await browser.eval(`(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth || [...document.querySelectorAll(".device-card,.stat-card,.owner-nav a,.device-controls > summary")].some(el => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && (b.left < -1 || b.right > innerWidth + 1);
        }),
        targetHeight: document.querySelector(".device-controls > summary").getBoundingClientRect().height,
        animations: document.getAnimations().length,
        rasterNodes: document.querySelectorAll("canvas,svg").length
      }))()`);
      assert.equal(compactLayout.overflow,false, "horizontal overflow at " + w);
      assert.ok(compactLayout.targetHeight >= 44, "small disclosure touch target at " + w);
      assert.equal(compactLayout.animations,0);
      assert.equal(compactLayout.rasterNodes,0);
      await browser.eval(`document.querySelector(".session-menu > summary").click()`);
      const sessionLayout: {inBounds:boolean; buttons:number; minHeight:number} = await browser.eval(`(() => {
        const el=document.querySelector(".session-actions");
        const b=el.getBoundingClientRect();
        const buttons=[...el.querySelectorAll("button:not(.hidden)")];
        return {inBounds:b.left>=-1 && b.right<=document.documentElement.clientWidth+1,buttons:buttons.length,minHeight:Math.min(...buttons.map(x=>x.getBoundingClientRect().height))};
      })()`);
      assert.equal(sessionLayout.inBounds,true,"session menu clipped at " + w);
      assert.equal(sessionLayout.buttons,2);
      if (m) assert.ok(sessionLayout.minHeight>=44);
      await browser.eval(`document.querySelector(".session-menu > summary").click()`);
    }
    await browser.setViewport(1280,860,false);
    await browser.eval(`document.querySelector('.device-card[data-device-id="Node-Online"] .device-controls > summary').click()`);
    assert.equal(await browser.eval<boolean>(`document.querySelector('.device-card[data-device-id="Node-Online"] .device-controls').open`),true);

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
    assert.equal(await browser.eval<number>(`document.querySelectorAll('.device-card[data-device-id="Node-Online"] [data-capability-state="full"],.device-card[data-device-id="Node-Online"] [data-capability-state="partial"]').length`),0,"pending policy cannot appear fully or partially live");
    assert.equal(await browser.eval<boolean>(`document.querySelector('.device-card[data-device-id="Node-Online"] .device-controls').open`),true,"expanded controls must persist across policy updates");
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
    assert.equal(await browser.eval<string>(`document.querySelector('.device-card[data-device-id="Node-Online"] [data-capability-family="process"]').dataset.capabilityState`),"off");
    assert.equal(await browser.eval<number>(`document.querySelectorAll('.device-card[data-device-id="Node-Online"] [data-capability-state="full"]').length`),5);
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
    await browser.eval(`(() => { const box=document.querySelector(".device-controls"); if(!box.open) box.querySelector("summary").click(); })()`);
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

    // A disconnected, previously confirmed device must never retain a live dial.
    roWs.close();
    await until(() => browser!.eval<boolean>(`document.querySelector('.device-card[data-device-id="Node-ReadOnly"] .device-title .pill')?.textContent === "Offline"`), 5_000, "confirmed device disconnected");
    assert.equal(await browser.eval<number>(`document.querySelectorAll('.device-card[data-device-id="Node-ReadOnly"] [data-capability-state="full"],.device-card[data-device-id="Node-ReadOnly"] [data-capability-state="partial"]').length`),0);
    assert.ok(!(await browser.eval<string>(`document.querySelector('[data-sync-badge="Node-ReadOnly"]')?.textContent || ""`)).startsWith("Confirmed Active"));

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


// Browser-to-relay functional contract. Every mutation uses temporary synthetic
// devices and an ephemeral test owner. Nothing contacts production.
test("owner controls: all navigation, session, device and global policy actions, operator profiles and rollback execute", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-portal-functional-"));
  const token = "synthetic-portal-functional-owner-token";
  const relay = await RelayServer.create({
    authenticator: new StaticClientAuthenticator([{
      token, accountId: "acct-functional", clientId: "functional-owner",
      principalId: "human:acct-functional", role: "owner",
    }]),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({host:"127.0.0.1",port:0});
  let browser: HeadlessBrowser | null = null;
  try {
    await pairDevice(address.httpUrl,token,"Fixture-A","synthetic-device-a-123456789");
    await pairDevice(address.httpUrl,token,"Fixture-B","synthetic-device-b-123456789");
    const getOverview = async (): Promise<any> => {
      const res=await fetch(address.httpUrl+"/portal/api/overview",{headers:{authorization:"Bearer "+token}});
      assert.equal(res.status,200);
      return res.json();
    };
    const device = async (id: string): Promise<any> => (await getOverview()).devices.find((x:any)=>x.deviceId===id);
    const dev = (id:string) => '.device-card[data-device-id="'+id+'"]';
    browser = await HeadlessBrowser.launch(path.join(dir,"chrome"));
    await browser.setViewport(390,844,true);
    await browser.navigate(address.httpUrl+"/portal");
    const ev = <T>(expr:string) => browser!.eval<T>(expr);
    const click = async (selector:string) => {
      const clicked=await ev<boolean>("(() => { const x=document.querySelector("+JSON.stringify(selector)+"); if(!x || x.disabled || !x.getClientRects().length || getComputedStyle(x).visibility==='hidden') return false; x.scrollIntoView({block:'nearest'}); x.click();return true;})()");
      assert.equal(clicked,true,"missing or inaccessible control "+selector);
    };
    const set = async (selector:string,value:string) => ev("(() => { const x=document.querySelector("+JSON.stringify(selector)+"); if(!x) throw Error('missing input'); x.value="+JSON.stringify(value)+"; x.dispatchEvent(new Event('input',{bubbles:true})); x.dispatchEvent(new Event('change',{bubbles:true})); })()");
    const open = async (selector:string) => {
      if (!await ev<boolean>("document.querySelector("+JSON.stringify(selector)+").open")) await click(selector+" > summary");
    };
    const visible = (selector:string) => ev<boolean>("Boolean(document.querySelector("+JSON.stringify(selector)+")?.getClientRects().length)");
    const waitForCards = () => until(()=>ev<boolean>("document.querySelectorAll('.device-card').length===2"),5000,"fixture cards");
    const signIn = async () => {
      await set("#token-input",token);
      await click("#connect-btn");
      await waitForCards();
    };
    const selectOnly = async (id:string) => {
      if(await visible("#clear-selected-devices-btn")) await click("#clear-selected-devices-btn");
      await click(dev(id)+' [data-action="select-device"]');
      assert.match(await ev<string>("document.getElementById('global-target-badge').textContent"),new RegExp(id));
    };
    const mutate = async (id:string,action:()=>Promise<void>,verify:(d:any)=>boolean) => {
      const before=(await device(id)).desiredRevision;
      await action();
      await until(async()=>{const d=await device(id);return d.desiredRevision>before && verify(d)},5000,"mutation "+id);
      const next=(await device(id)).desiredRevision;
      await until(()=>ev<boolean>("Boolean(document.querySelector("+JSON.stringify('[data-sync-detail="'+id+'"]')+")?.textContent.includes('v"+next+" '))"),5000,"UI reflects revision "+next);
    };
    const confirm = async (id:string, reason:string) => {
      await click(id);
      assert.equal(await ev<boolean>("document.getElementById('confirm-modal').classList.contains('active')"),true);
      await set("#modal-reason",reason);
      await click("#modal-confirm-btn");
    };
    // No silent blank login. Valid login and authenticated refresh.
    await click("#connect-btn");
    assert.match(await ev<string>("document.getElementById('status-banner').textContent"),/Enter an owner bearer token/);
    await signIn();
    const updatedBefore = await ev<string>("document.querySelector('.fleet-meta').textContent");
    assert.match(updatedBefore,/Updated/);
    await click("#refresh-btn");
    await until(()=>ev<boolean>("!document.getElementById('refresh-btn').disabled"),5000,"refresh finished");

    // Section links must navigate to existing visible targets, not placeholders.
    for(const hash of ["#devices-container","#global-controls","#owner-identities","#security-audit"]){
      await click('.owner-nav a[href="'+hash+'"]');
      assert.equal(await ev<string>("location.hash"),hash);
      assert.equal(await visible(hash),true);
    }
    await open(".session-menu");
    await click("#live-alerts-btn");
    assert.equal(await ev<string>("document.getElementById('live-alerts-btn').getAttribute('aria-pressed')"),"true");
    await click(".toast-dismiss");
    await click("#live-alerts-btn");
    assert.equal(await ev<string>("document.getElementById('live-alerts-btn').getAttribute('aria-pressed')"),"false");
    await click(".session-menu > summary");
    // All, Online(empty), Offline, Attention, and empty result reset.
    await click('[data-action="fleet-filter"][data-filter="online"]');
    assert.equal(await ev<number>("document.querySelectorAll('.device-card').length"),0);
    await click('#devices-container [data-action="fleet-filter"][data-filter="all"]');
    await waitForCards();
    await click('[data-action="fleet-filter"][data-filter="offline"]');
    await waitForCards();
    await click('[data-action="fleet-filter"][data-filter="attention"]');
    await waitForCards();
    await click('[data-action="fleet-filter"][data-filter="all"]');
    // Actual selection controls and policy disclosure.
    await click("#select-all-devices-btn");
    assert.equal(await ev<number>("document.querySelectorAll('.device-select-cb:checked').length"),2);
    assert.equal(await visible("#select-all-devices-btn"),false);
    await click("#clear-selected-devices-btn");
    assert.equal(await ev<number>("document.querySelectorAll('.device-select-cb:checked').length"),0);
    assert.equal(await visible("#clear-selected-devices-btn"),false);
    await open(".policy-explainer");
    await click(".policy-explainer > summary");
    await open(dev("Fixture-A")+" .device-controls");
    await open(dev("Fixture-A")+" details.advanced-box");

    const rule=dev("Fixture-A")+' [data-role="op-rule-input"]';
    const deny=dev("Fixture-A")+' [data-action="deny-op"]';
    const allow=dev("Fixture-A")+' [data-action="allow-op"]';
    const beforeBlank=(await device("Fixture-A")).desiredRevision;
    await click(deny);
    assert.equal(await ev<boolean>("document.querySelector("+JSON.stringify(rule)+").validity.valid"),false);
    await set(rule,"not.a.real.operation");
    await click(deny);
    assert.equal(await ev<boolean>("document.querySelector("+JSON.stringify(rule)+").validity.valid"),false);
    assert.equal((await device("Fixture-A")).desiredRevision,beforeBlank);
    await set(rule,"filesystem.write");
    await mutate("Fixture-A",()=>click(deny),d=>d.policy.owner_policy.denied_capabilities.includes("filesystem.write"));
    await set(rule,"filesystem.write");
    await mutate("Fixture-A",()=>click(allow),d=>!d.policy.owner_policy.denied_capabilities.includes("filesystem.write"));

    // Every family control uses the same handler; verify each family round-trip.
    for (const family of ALL_TOOL_FAMILIES) {
      const selector=dev("Fixture-A")+' [data-action="toggle-family"][data-family="'+family+'"]';
      await mutate("Fixture-A",()=>click(selector),d=>!d.familySummaries.find((f:any)=>f.family===family).granted);
      await mutate("Fixture-A",()=>click(selector),d=>d.familySummaries.find((f:any)=>f.family===family).granted);
    }
    // Three local profile controls.
    for (const profile of ["read_only","lockdown","universal"]) {
      await mutate("Fixture-A",()=>click(dev("Fixture-A")+' [data-action="device-profile"][data-profile="'+profile+'"]'),d=>d.policy.owner_policy.profile_id===profile);
    }
    // Bulk confirmation cancellation must not mutate. Then apply each action to exactly A.
    await selectOnly("Fixture-A");
    const bRevision=(await device("Fixture-B")).desiredRevision;
    const aBeforeCancel=(await device("Fixture-A")).desiredRevision;
    await click("#global-readonly-btn");
    await click("#modal-cancel-btn");
    assert.equal((await device("Fixture-A")).desiredRevision,aBeforeCancel);
    await mutate("Fixture-A",()=>confirm("#global-readonly-btn","functional read-only"),d=>d.policy.owner_policy.profile_id==="read_only");
    await mutate("Fixture-A",()=>confirm("#global-revoke-btn","functional revoke"),d=>d.policy.owner_policy.profile_id==="lockdown");
    await mutate("Fixture-A",()=>confirm("#global-universal-btn","functional grant"),d=>d.policy.owner_policy.profile_id==="universal");
    await mutate("Fixture-A",()=>confirm("#emergency-revoke-btn","functional emergency"),d=>d.emergencyLockdown===true);
    assert.equal(await visible(dev("Fixture-A")+' [data-action="toggle-family"]'),false);
    assert.equal(await visible(dev("Fixture-A")+' [data-action="device-profile"]'),false);
    assert.equal(await visible(dev("Fixture-A")+' [data-action="lift-lockdown"]'),true);
    // Lift is only actionable if locked devices are selected.
    await selectOnly("Fixture-B");
    assert.equal(await visible("#global-lift-lockdown-btn"),false);
    await selectOnly("Fixture-A");
    await mutate("Fixture-A",()=>confirm("#global-lift-lockdown-btn","functional lift"),d=>!d.emergencyLockdown);
    await mutate("Fixture-A",()=>confirm("#emergency-revoke-btn","local lift fixture"),d=>d.emergencyLockdown===true);
    await mutate("Fixture-A",()=>click(dev("Fixture-A")+' [data-action="lift-lockdown"]'),d=>!d.emergencyLockdown);
    assert.equal((await device("Fixture-B")).desiredRevision,bRevision,"scoped changes must not affect B");

    // Operator authorization: blank input rejected; every profile option reaches relay.
    await selectOnly("Fixture-A");
    await open("#operator-advanced-box");
    await click("#save-operator-btn");
    assert.equal(await ev<boolean>("document.getElementById('op-principal-id').validity.valid"),false);
    for(const profile of ["read_only","files_and_process","standard","universal","lockdown"]){
      await set("#op-principal-id","operator:functional");
      await set("#op-display-name","Synthetic functional operator");
      await set("#op-profile-id",profile);
      await mutate("Fixture-A",()=>click("#save-operator-btn"),d=>d.policy.operator_policies["operator:functional"]?.profile_id===profile);
      assert.equal((await device("Fixture-B")).policy.operator_policies["operator:functional"],undefined);
    }
    await selectOnly("Fixture-B");
    await click('[data-action="edit-operator"][data-principal="operator:functional"]');
    assert.equal(await ev<string>("document.getElementById('op-principal-id').value"),"operator:functional");
    assert.equal(await ev<string>("document.getElementById('op-profile-id').value"),"lockdown");
    assert.equal(await ev<boolean>("document.querySelector('.device-card[data-device-id=Fixture-A] .device-select-cb').checked"),true);
    assert.equal(await ev<boolean>("document.querySelector('.device-card[data-device-id=Fixture-B] .device-select-cb').checked"),false);
    await mutate("Fixture-A",()=>click('[data-action="remove-operator"][data-principal="operator:functional"]'),d=>!d.policy.operator_policies["operator:functional"]);
    assert.equal((await device("Fixture-B")).desiredRevision,bRevision);

    // Snapshot filter, pagination and rollback against actual revision history.
    await open("#snapshots-advanced-box");
    await set("#snapshot-device-filter","Fixture-A");
    assert.equal(await ev<string>("document.getElementById('snapshot-device-filter').value"),"Fixture-A");
    const rowsBefore=await ev<number>("document.querySelectorAll('#snapshots-container .snapshot-row').length");
    assert.equal(rowsBefore,10);
    await click('[data-action="snapshots-more"]');
    assert.ok(await ev<number>("document.querySelectorAll('#snapshots-container .snapshot-row').length")>rowsBefore);
    while(await visible('[data-action="snapshots-more"]')) await click('[data-action="snapshots-more"]');
    await mutate("Fixture-A",()=>click('[data-action="rollback"][data-device="Fixture-A"][data-rev="1"]'),d=>d.policy.owner_policy.profile_id==="universal");
    assert.equal((await device("Fixture-B")).desiredRevision,bRevision);

    await open(".session-menu");
    await click("#logout-btn");
    await until(()=>ev<boolean>("document.body.dataset.auth==='signed-out'"),5000,"sign out");
    assert.equal(await ev<number>("document.querySelectorAll('.device-card').length"),0);
    assert.equal(await visible(".owner-nav"),false);
    await signIn();
    assert.equal(await ev<number>("sessionStorage.length+localStorage.length"),0);
    assert.deepEqual(browser.exceptions,[]);
    assert.deepEqual(browser.consoleErrors,[]);
  } finally {
    await browser?.close();
    await relay.close();
    await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50});
  }
});

test("owner portal empty fleet and read-only pilot omit unavailable controls", async () => {
  for(const readOnly of [false,true]){
    const dir=await mkdtemp(path.join(os.tmpdir(),"tether-portal-mode-"));
    const token="synthetic-mode-owner-token";
    const relay=await RelayServer.create({
      authenticator:new StaticClientAuthenticator([{token,accountId:"acct-mode",clientId:"mode-owner",principalId:"human:acct-mode",role:"owner"}]),
      stateFile:path.join(dir,"devices.json"),
      allowInsecureLocalhost:true,
      ...(readOnly?{portalPort:0,portalReadOnly:true}:{}),
    });
    let browser:HeadlessBrowser|null=null;
    try {
      const address=await relay.listen({host:"127.0.0.1",port:0});
      const portalUrl=readOnly?address.portalListenUrl!:address.httpUrl;
      browser=await HeadlessBrowser.launch(path.join(dir,"chrome"));
      await browser.setViewport(320,740,true);
      await browser.navigate(portalUrl+"/portal");
      const ev=<T>(expr:string)=>browser!.eval<T>(expr);
      await ev("document.getElementById('token-input').value="+JSON.stringify(token)+";document.getElementById('connect-btn').click()");
      await until(()=>ev<boolean>("document.getElementById('devices-container').textContent.includes('No paired devices')"),5000,"empty overview");
      assert.equal(await ev<boolean>("Boolean(document.querySelector('#global-controls').getClientRects().length)"),false);
      assert.equal(await ev<boolean>("Boolean(document.querySelector('#operator-advanced-box').getClientRects().length)"),false);
      assert.equal(await ev<boolean>("Boolean(document.querySelector('.owner-nav a[href=\"#global-controls\"]').getClientRects().length)"),false);
      assert.equal(await ev<boolean>("Boolean(document.querySelector('.snapshot-controls').getClientRects().length)"),false);
      await pairDevice(address.httpUrl,token,"Mode-Fixture","synthetic-mode-fixture-secret-123");
      await ev("document.getElementById('refresh-btn').click()");
      await until(()=>ev<boolean>("document.querySelectorAll('.device-card').length===1"),5000,"paired fixture");
      await ev("document.querySelector('.device-controls > summary').click()");
      assert.equal(await ev<boolean>("document.body.dataset.portalReadOnly==='true'"),readOnly);
      assert.equal(await ev<number>("document.querySelectorAll('.device-card [data-action=toggle-family]').length"),readOnly?0:6);
      assert.equal(await ev<number>("document.querySelectorAll('.device-card [data-action=select-device]').length"),readOnly?0:1);
      assert.equal(await ev<boolean>("Boolean(document.getElementById('global-controls').getClientRects().length)"),!readOnly);
      assert.equal(await ev<boolean>("Boolean(document.getElementById('operator-advanced-box').getClientRects().length)"),!readOnly);
      assert.equal(await ev<boolean>("Boolean(document.querySelector('.read-only-notice').getClientRects().length)"),readOnly);
      await ev("document.querySelector('#snapshots-advanced-box > summary').click()");
      assert.equal(await ev<number>("document.querySelectorAll('[data-action=rollback]').length"),readOnly?0:1);
      assert.equal(await ev<number>("document.querySelectorAll('.capability-segment').length"),6);
      await ev("document.querySelector('.session-menu > summary').click();document.getElementById('logout-btn').click()");
      await until(()=>ev<boolean>("document.body.dataset.auth==='signed-out'"),5000,"sign out in mode");
      assert.deepEqual(browser.exceptions,[]);
      assert.deepEqual(browser.consoleErrors,[]);
    } finally {
      await browser?.close();
      await relay.close();
      await rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:50});
    }
  }
});
