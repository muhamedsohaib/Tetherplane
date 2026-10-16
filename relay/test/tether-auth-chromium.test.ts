import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";
import WebSocket from "ws";

import { createSqliteAdapter } from "../../auth/src/sqlite-adapter.ts";
import { createTetherAuthRuntime } from "../../auth/src/runtime.ts";
import { readChromiumDevToolsPort } from "./helpers/chromium-debug-port.ts";

function chromiumBinary(): string | null {
  const override = process.env.TETHERPLANE_CHROMIUM_BIN;
  if (override && existsSync(override)) {
    return override;
  }
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const candidates = [
    join(
      home,
      "AppData",
      "Local",
      "ms-playwright",
      "chromium-1244",
      "chrome-win64",
      "chrome.exe",
    ),
    join(
      home,
      ".cache",
      "ms-playwright",
      "chromium-1244",
      "chrome-linux",
      "chrome",
    ),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const CHROME = chromiumBinary();

type Cdp = {
  send<T>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (method: string, text: string) => void): void;
  close(): void;
};

async function connectCdp(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const listeners = new Set<(method: string, text: string) => void>();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    if (
      typeof message.id === "number" &&
      pending.has(message.id)
    ) {
      const entry = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) {
        entry.reject(
          new Error(message.error.message ?? "CDP error"),
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      const text = JSON.stringify(message.params ?? null).slice(
        0,
        300,
      );
      for (const listener of listeners) {
        listener(message.method, text);
      }
    }
  });
  return {
    send<T>(method: string, params?: unknown): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
    },
    close() {
      socket.close();
    },
  };
}

test(
  "chromium completes the browser flow to a loopback callback without CSP violations",
  { skip: CHROME === null, timeout: 90_000 },
  async () => {
    const keys = await generateKeyPair("RS256", {
      extractable: true,
    });
    const privateJwk = {
      ...(await exportJWK(keys.privateKey)),
      kid: "chromium-flow",
      alg: "RS256",
      use: "sig",
    };
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "tether-chromium-")),
      "provider.sqlite",
    );
    const storage = createSqliteAdapter({ databasePath });
    const runtime = createTetherAuthRuntime({
      issuer: "https://auth.example.test/",
      resource: "https://mcp.example.test/mcp",
      interactionBasePath: "/interaction",
      jwks: { keys: [privateJwk] },
      adapter: storage.Adapter,
      logins: {
        start: async () => ({
          userCode: "ABCD-1234",
          expiresAt: "2030-01-01T00:00:00.000Z",
        }),
        consume: async () => ({ accountId: "account-a" }),
      },
      allowInsecureLocalhost: true,
    });
    const address = await runtime.server.listen({
      host: "127.0.0.1",
      port: 0,
    });

    let callbackHit = false;
    let callbackStateOk = false;
    const callbackServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/callback") {
        callbackHit = true;
        callbackStateOk =
          url.searchParams.get("state") === "chromium-state" &&
          (url.searchParams.get("code") ?? "").length > 8;
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end("<!doctype html><title>done</title>");
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      callbackServer.listen(0, "127.0.0.1", resolve),
    );
    const callbackPort = (callbackServer.address() as AddressInfo)
      .port;
    const callbackBase = `http://127.0.0.1:${callbackPort}/callback`;

    const registered = (await (
      await fetch(`${address.url}/reg`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [callbackBase],
          client_name: "chromium-client",
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "openid offline_access tetherplane:access",
        }),
      })
    ).json()) as { client_id: string };
    const authParams = new URLSearchParams({
      client_id: registered.client_id,
      redirect_uri: callbackBase,
      response_type: "code",
      scope: "openid offline_access tetherplane:access",
      code_challenge:
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource: "https://mcp.example.test/mcp",
      state: "chromium-state",
    });

    const profileDir = mkdtempSync(
      join(tmpdir(), "tether-chromium-profile-"),
    );
    let chrome: ChildProcess | null = null;
    const violations: Array<string> = [];
    const record = (method: string, text: string) => {
      if (
        method === "Log.entryAdded" ||
        method === "Runtime.consoleAPICalled" ||
        method === "Runtime.exceptionThrown"
      ) {
        if (/content-security-policy|form-action/i.test(text)) {
          violations.push(`${method}: ${text.slice(0, 200)}`);
        }
      }
    };
    try {
      chrome = spawn(
        CHROME!,
        [
          "--headless=new",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-gpu",
          "--remote-debugging-port=0",
          `--user-data-dir=${profileDir}`,
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      let debuggerUrl = "";
      let debugPort = 0;
      for (let i = 0; i < 75 && !debuggerUrl; i += 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, 200),
        );
        try {
          // A unique, freshly-created Chrome profile is the authority for
          // its ephemeral CDP port. Never attach to a shared fixed port.
          debugPort = await readChromiumDevToolsPort(profileDir);
          const version = (await (
            await fetch(
              `http://127.0.0.1:${debugPort}/json/version`,
              { signal: AbortSignal.timeout(1000) },
            )
          ).json()) as { webSocketDebuggerUrl: string };
          debuggerUrl = version.webSocketDebuggerUrl;
        } catch {
          debuggerUrl = "";
        }
      }
      assert.ok(
        debuggerUrl,
        "chromium remote debugging must become available",
      );
      const targets = (await (
        await fetch(
          `http://127.0.0.1:${debugPort}/json/list`,
        )
      ).json()) as Array<{
        type: string;
        webSocketDebuggerUrl: string;
      }>;
      const page = targets.find(
        (target) => target.type === "page",
      );
      assert.ok(page, "chromium must expose a page target");
      const cdp = await connectCdp(page.webSocketDebuggerUrl);
      try {
        cdp.onEvent(record);
        await cdp.send("Page.enable");
        await cdp.send("Log.enable");
        await cdp.send("Runtime.enable");
        const evaluate = async (
          expression: string,
        ): Promise<string> => {
          const outcome = (await cdp.send<{
            result: { value?: unknown };
          }>("Runtime.evaluate", {
            expression,
            returnByValue: true,
          })) as { result: { value?: unknown } };
          return String(outcome.result.value ?? "");
        };
        await cdp.send("Page.navigate", {
          url: `${address.url}/auth?${authParams.toString()}`,
        });
        const deadline = Date.now() + 45_000;
        let lastUrl = "";
        while (Date.now() < deadline && !callbackHit) {
          const href = await evaluate("location.href");
          if (href !== lastUrl) {
            lastUrl = href;
            if (href.startsWith(callbackBase)) {
              break;
            }
            if (
              href.includes("/interaction/") &&
              !href.includes("/consent") &&
              !href.includes("/device-login")
            ) {
              const kind = await evaluate(
                "document.querySelector('form')?.getAttribute('action') ?? 'none'",
              );
              if (
                kind.includes("/device-login") ||
                kind.includes("/consent")
              ) {
                await evaluate(
                  "document.querySelector('form').submit()",
                );
              }
            }
          }
          await new Promise((resolve) =>
            setTimeout(resolve, 500),
          );
        }
        assert.ok(
          callbackHit,
          "chromium must reach the loopback callback",
        );
        assert.ok(
          callbackStateOk,
          "callback must carry the expected state and a code",
        );
        assert.deepEqual(
          violations,
          [],
          "chromium must report no CSP violations",
        );
      } finally {
        cdp.close();
      }
    } finally {
      if (chrome) {
        if (process.platform === "win32" && chrome.pid && chrome.exitCode === null) {
          // Terminate only the headless Chrome tree launched by this test;
          // chrome.kill() alone can orphan Chromium subprocesses on Windows.
          try {
            execFileSync("taskkill.exe", ["/PID", String(chrome.pid), "/T", "/F"], {
              stdio: "ignore",
              timeout: 10_000,
            });
          } catch {
            chrome.kill();
          }
        } else {
          chrome.kill();
        }
      }
      await runtime.server.close();
      storage.close();
      await new Promise<void>((resolve) =>
        callbackServer.close(() => resolve()),
      );
    }
  },
);
