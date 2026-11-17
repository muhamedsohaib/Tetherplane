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

  private constructor(
    child: ChildProcess,
    ws: globalThis.WebSocket,
  ) {
    this.#child = child;
    this.#ws = ws;
  }

  static async launch(profileDir: string): Promise<HeadlessBrowser> {
    const executable = await findInstalledChromium();
    assert.ok(executable, "expected Chromium executable to be installed");
    await mkdir(profileDir, { recursive: true });
    const child = spawn(
      executable,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "about:blank",
      ],
      { stdio: "ignore" },
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
      ((await this.#send("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string });
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

  async navigate(url: string): Promise<void> {
    await this.#pageSend("Page.navigate", { url });
    await until(
      () => this.eval<boolean>("document.readyState === 'complete'"),
      10_000,
      "document readyState",
    );
  }

  async reload(): Promise<void> {
    await this.#pageSend("Page.reload", {});
    await until(
      () => this.eval<boolean>("document.readyState === 'complete'"),
      10_000,
      "reload complete",
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
      throw new Error(
        `Page eval failed: ${JSON.stringify(res.exceptionDetails)}`,
      );
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
      this.#child.kill("SIGKILL");
      await once(this.#child, "exit").catch(() => {});
    }
  }
}

test("portal blocks adversarial XSS payloads, obeys strict CSP, and stores session only in HttpOnly cookie", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-portal-xss-e2e-"));
  const ownerToken = "owner-portal-browser-secret-token";
  const relay = await RelayServer.create({
    authenticator: new StaticClientAuthenticator([
      {
        token: ownerToken,
        accountId: "account-a",
        clientId: "portal-owner-a",
        principalId: "human:account-a",
      },
    ]),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  const xssDeviceId = "XssTestDevice";
  const deviceSecret = "device-secret-xss-adversarial-32chars";
  let socket: RawDeviceWs | null = null;
  let browser: HeadlessBrowser | null = null;

  try {
    const startRes = await fetch(`${address.httpUrl}/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: xssDeviceId,
        credentialHash: hashDeviceCredential(deviceSecret),
      }),
    }).then((r) => r.json() as Promise<{ userCode: string }>);
    const appRes = await fetch(`${address.httpUrl}/pair/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({ userCode: startRes.userCode }),
    });
    assert.equal(appRes.status, 200);

    // Add an operator & audit event containing XSS payloads
    const opRes = await fetch(`${address.httpUrl}/portal/api/operators`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        principalId: 'operator:<script>window.__xss=3</script>',
        displayName: '<svg onload="window.__xss=4">',
        profileId: "read_only",
        reason: '<img src=x onerror="window.__xss=5">',
      }),
    });
    assert.equal(opRes.status, 200);

    // Explicitly add an XSS capability string into deniedCapabilities & audit reason
    const capRes = await fetch(
      `${address.httpUrl}/portal/api/devices/${xssDeviceId}/policy`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          revokeCapabilities: ['"><img src=x onerror="window.__xss=8">'],
          reason: '<img src=x onerror="window.__xss=9">',
        }),
      },
    );
    assert.equal(capRes.status, 200);

    // Connect device over WS and report XSS-laden telemetry / unavailable provider
    socket = await RawDeviceWs.connect(address.deviceWsUrl, {
      authorization: `Device ${deviceSecret}`,
      "x-tetherplane-device-id": xssDeviceId,
    });
    socket.sendJson({
      type: "device_hello",
      deviceId: xssDeviceId,
      appliedPolicyRevision: 2,
      status: {
        os: '<img src=x onerror="window.__xss=6">',
        arch: "x86_64",
        agent_version: "0.1.0",
        policy_mode: "background_only",
      },
      capabilities: {
        providers: [
          {
            namespace: "browser",
            tool_family: "browser",
            available: false,
            status: "unavailable",
            unavailable_reason: '<img src=x onerror="window.__xss=7">',
          },
        ],
      },
    });
    await until(async () => {
      const ov = await fetch(`${address.httpUrl}/portal/api/overview`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }).then((r) => r.json() as Promise<{ devices: Array<{ online: boolean }> }>);
      return ov.devices[0]?.online === true;
    }, 5_000, "device_hello applied");

    browser = await HeadlessBrowser.launch(path.join(dir, "chrome-profile"));
    await browser.navigate(`${address.httpUrl}/portal`);

    // Sign in through the real Portal Connect button
    await browser.eval(`(() => {
      const input = document.getElementById("token-input");
      input.value = ${JSON.stringify(ownerToken)};
      document.getElementById("connect-btn").click();
    })()`);

    await until(
      () =>
        browser!.eval<boolean>(
          "document.querySelectorAll('.device-card').length === 1",
        ),
      10_000,
      "XSS device card rendered",
    );

    const securityAudit = await browser.eval<{
      xssFlag: unknown;
      sessionStorageLen: number;
      localStorageLen: number;
      tokenInputVal: string;
      documentCookie: string;
      scriptCount: number;
      imgOrSvgCount: number;
      firstDeviceTitle: string;
      bodyText: string;
    }>(`(() => ({
      xssFlag: window.__xss ?? null,
      sessionStorageLen: sessionStorage.length,
      localStorageLen: localStorage.length,
      tokenInputVal: document.getElementById("token-input").value,
      documentCookie: document.cookie,
      scriptCount: document.querySelectorAll("script").length,
      imgOrSvgCount: document.querySelectorAll("img, svg").length,
      firstDeviceTitle: document.querySelector(".device-card h3").textContent,
      bodyText: document.body.textContent,
    }))()`);

    assert.equal(securityAudit.xssFlag, null);
    assert.equal(securityAudit.sessionStorageLen, 0);
    assert.equal(securityAudit.localStorageLen, 0);
    assert.equal(securityAudit.tokenInputVal, "");
    assert.equal(securityAudit.documentCookie, "");
    assert.equal(securityAudit.scriptCount, 1);
    assert.equal(securityAudit.imgOrSvgCount, 0);
    assert.equal(securityAudit.firstDeviceTitle, xssDeviceId);
    assert.ok(securityAudit.bodyText.includes('<img src=x onerror="window.__xss=7">'));
    assert.ok(securityAudit.bodyText.includes('operator:<script>window.__xss=3</script>'));
    assert.deepEqual(browser.exceptions, []);
    assert.deepEqual(browser.consoleErrors, []);

    // Verify interactive op deny button works safely via cookie session
    await browser.eval(`(() => {
      const card = document.querySelector(".device-card");
      card.querySelector("[data-role='op-rule-input']").value = "process.terminate";
      card.querySelector("[data-action='deny-op']").click();
    })()`);
    await until(
      () =>
        browser!.eval<boolean>(
          `document.body.textContent.includes("Explicitly deny process.terminate")`,
        ),
      10_000,
      "deny op reflected after cookie mutation",
    );

    // Reload page: HttpOnly cookie restores session cleanly with zero client storage
    await browser.reload();
    await until(
      () =>
        browser!.eval<boolean>(
          "document.querySelectorAll('.device-card').length === 1",
        ),
      10_000,
      "session restored after reload via HttpOnly cookie",
    );
    assert.equal(await browser.eval("sessionStorage.length"), 0);
    assert.equal(await browser.eval("window.__xss ?? null"), null);

    // Sign Out invalidates session and persists across reload
    await browser.eval(`document.getElementById("logout-btn").click()`);
    await until(
      () =>
        browser!.eval<boolean>(
          `document.getElementById("auth-state-badge").textContent === "Not Signed In"`,
        ),
      10_000,
      "signed out UI",
    );
    await browser.reload();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      await browser.eval<string>(
        `document.getElementById("auth-state-badge").textContent`,
      ),
      "Not Signed In",
    );
    assert.deepEqual(browser.exceptions, []);
    assert.deepEqual(browser.consoleErrors, []);
  } finally {
    await browser?.close();
    socket?.close();
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});
