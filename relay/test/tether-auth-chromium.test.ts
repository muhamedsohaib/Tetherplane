import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";
import { rm } from "node:fs/promises";

import { createSqliteAdapter } from "../../auth/src/sqlite-adapter.ts";
import { createTetherAuthRuntime } from "../../auth/src/runtime.ts";
import { closeChromiumFromProfile, connectTestCdp, readChromiumDevToolsPort, withChromiumTestResources } from "./helpers/chromium-debug-port.ts";

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


test(
  "chromium completes the browser flow to a loopback callback without CSP violations",
  { skip: CHROME === null, timeout: 90_000 },
  async () => withChromiumTestResources(async (defer) => {
    const keys = await generateKeyPair("RS256", {
      extractable: true,
    });
    const privateJwk = {
      ...(await exportJWK(keys.privateKey)),
      kid: "chromium-flow",
      alg: "RS256",
      use: "sig",
    };
    const databaseDir = mkdtempSync(join(tmpdir(), "tether-chromium-"));
    defer(() => rm(databaseDir, { recursive: true, force: true }));
    const databasePath = join(databaseDir, "provider.sqlite");
    const storage = createSqliteAdapter({ databasePath });
    defer(() => storage.close());
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
    defer(() => runtime.server.close());
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
    defer(async () => {
      callbackServer.closeAllConnections();
      if (callbackServer.listening) await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      callbackServer.once("error", reject);
      callbackServer.listen(0, "127.0.0.1", resolve);
    });
    const callbackPort = (callbackServer.address() as AddressInfo)
      .port;
    const callbackBase = `http://127.0.0.1:${callbackPort}/callback`;

    const registered = (await (
      await fetch(`${address.url}/reg`, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
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
    let browserClosed = false;
    defer(async () => { if (!chrome || browserClosed) await rm(profileDir, { recursive: true, force: true }); });
    defer(async () => {
      if (!chrome) return;
      // No PID fallback after launcher exit: it could now be an unrelated
      // process. Missing private debugger evidence remains a reported cleanup
      // blocker requiring ownership-scoped operator recovery.
      await closeChromiumFromProfile(profileDir);
      if (process.platform === "win32") {
        const literal = profileDir.replaceAll("'", "''");
        const deadline = Date.now() + 10_000;
        let remaining = "";
        do {
          remaining = execFileSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            "@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + literal + "') }).Count",
          ], { encoding: "utf8", windowsHide: true, timeout: 5000 }).trim();
          if (Number(remaining) === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        assert.equal(Number(remaining), 0, "test-owned Chromium profile processes must all exit");
      }
      browserClosed = true;
    });
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
        { stdio: "ignore", windowsHide: true },
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
          `http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2000) },
        )
      ).json()) as Array<{
        type: string;
        webSocketDebuggerUrl: string;
      }>;
      const page = targets.find(
        (target) => target.type === "page",
      );
      assert.ok(page, "chromium must expose a page target");
      const cdp = await connectTestCdp(page.webSocketDebuggerUrl);
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

  }),
);
