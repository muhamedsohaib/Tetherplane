import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";

import { createSqliteAdapter } from "../../auth/src/sqlite-adapter.ts";
import { createTetherAuthRuntime } from "../../auth/src/runtime.ts";

type Jar = Map<string, string>;

function storeCookies(jar: Jar, response: Response): void {
  const setCookies =
    response.headers.getSetCookie !== undefined
      ? response.headers.getSetCookie()
      : [];
  for (const entry of setCookies) {
    const pair = entry.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0) {
      jar.set(
        pair.slice(0, separator).trim(),
        pair.slice(separator + 1).trim(),
      );
    }
  }
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

test("full browser flow reaches consent after device approval", async () => {
  const keys = await generateKeyPair("RS256", {
    extractable: true,
  });
  const privateJwk = {
    ...(await exportJWK(keys.privateKey)),
    kid: "full-flow",
    alg: "RS256",
    use: "sig",
  };
  const databasePath = join(
    mkdtempSync(join(tmpdir(), "tether-full-flow-")),
    "provider.sqlite",
  );
  const storage = createSqliteAdapter({ databasePath });
  let approved = false;
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
      consume: async () =>
        approved ? { accountId: "account-a" } : null,
    },
    allowInsecureLocalhost: true,
  });

  const address = await runtime.server.listen({
    host: "127.0.0.1",
    port: 0,
  });
  const jar: Jar = new Map();
  try {
    const challenged = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const authParams = new URLSearchParams({
      client_id: "will-register",
      redirect_uri: "http://127.0.0.1:8765/callback",
      response_type: "code",
      scope: "openid offline_access tetherplane:access",
      code_challenge: challenged,
      code_challenge_method: "S256",
      resource: "https://mcp.example.test/mcp",
      state: "flow-state",
    });

    const registered = await fetch(`${address.url}/reg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:8765/callback"],
        client_name: "full-flow-client",
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "openid offline_access tetherplane:access",
      }),
    });
    assert.equal(registered.status, 201);
    const client = (await registered.json()) as {
      client_id: string;
    };
    authParams.set("client_id", client.client_id);

    const auth = await fetch(
      `${address.url}/auth?${authParams.toString()}`,
      { redirect: "manual" },
    );
    assert.ok(
      auth.status === 302 || auth.status === 303,
      `authorization must redirect, got ${auth.status}`,
    );
    storeCookies(jar, auth);
    const loginUrl = new URL(
      auth.headers.get("location") ?? "",
      address.url,
    );
    assert.match(loginUrl.pathname, /^\/interaction\//);

    const page = await fetch(loginUrl, {
      headers: {
        accept: "text/html",
        cookie: cookieHeader(jar),
      },
    });
    assert.equal(page.status, 200);
    storeCookies(jar, page);
    const html = await page.text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(
      html,
    )?.[1];
    assert.ok(csrf, "login page must carry a CSRF token");
    assert.ok(
      html.includes("ABCD-1234"),
      "login page must show the device code",
    );

    approved = true;
    const continued = await fetch(
      `${address.url}${loginUrl.pathname}/device-login`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type":
            "application/x-www-form-urlencoded",
          accept: "text/html",
          cookie: cookieHeader(jar),
        },
        body: new URLSearchParams({
          userCode: "ABCD-1234",
          csrf,
        }),
      },
    );
    storeCookies(jar, continued);
    assert.ok(
      continued.status === 302 ||
        continued.status === 303,
      "approved login must resume the provider flow",
    );
    const resumeUrl = new URL(
      continued.headers.get("location") ?? "",
      address.url,
    );
    const resumed = await fetch(resumeUrl, {
      redirect: "manual",
      headers: { cookie: cookieHeader(jar) },
    });
    storeCookies(jar, resumed);
    assert.ok(resumed.status === 302 || resumed.status === 303);
    const consentUrl = new URL(
      resumed.headers.get("location") ?? "",
      address.url,
    );
    assert.match(consentUrl.pathname, /^\/interaction\//);

    const consentPage = await fetch(consentUrl, {
      headers: {
        accept: "text/html",
        cookie: cookieHeader(jar),
      },
    });
    const consentHtml = await consentPage.text();
    assert.equal(
      consentPage.status,
      200,
      `consent page must render, got ${consentPage.status}: ${consentHtml.slice(0, 200)}`,
    );
    assert.ok(
      consentHtml.includes("tetherplane:access"),
      "consent page must present the requested scope",
    );
    const consentCsrf = /name="csrf" value="([a-f0-9]{64})"/.exec(
      consentHtml,
    )?.[1];
    assert.ok(
      consentCsrf,
      "consent page must carry a CSRF token",
    );

    const granted = await fetch(
      `${address.url}${consentUrl.pathname}/consent`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type":
            "application/x-www-form-urlencoded",
          accept: "text/html",
          cookie: cookieHeader(jar),
        },
        body: new URLSearchParams({
          csrf: consentCsrf,
        }),
      },
    );
    storeCookies(jar, granted);
    assert.ok(
      granted.status === 302 || granted.status === 303,
      `consent must resume the flow, got ${granted.status}`,
    );
    let callback: URL | null = null;
    let next: URL | null = new URL(
      granted.headers.get("location") ?? "",
      address.url,
    );
    for (let hop = 0; hop < 6 && next; hop += 1) {
      const step: Response = await fetch(next, {
        redirect: "manual",
        headers: { cookie: cookieHeader(jar) },
      });
      storeCookies(jar, step);
      if (step.status !== 302 && step.status !== 303) {
        break;
      }
      next = new URL(
        step.headers.get("location") ?? "",
        address.url,
      );
      if (next.searchParams.has("code")) {
        callback = next;
        break;
      }
    }
    assert.ok(
      callback,
      "resume chain must reach the client callback",
    );
    const code = callback.searchParams.get("code");
    assert.ok(code, "callback must carry an authorization code");
    assert.equal(
      callback.searchParams.get("state"),
      "flow-state",
    );

    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const exchanged = await fetch(`${address.url}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:8765/callback",
        client_id: client.client_id,
        code_verifier: verifier,
        resource: "https://mcp.example.test/mcp",
      }),
    });
    assert.equal(exchanged.status, 200);
    const tokens = (await exchanged.json()) as {
      access_token: string;
      refresh_token?: string;
      token_type: string;
    };
    assert.equal(tokens.token_type, "Bearer");
    assert.ok(tokens.refresh_token, "flow must issue a refresh token");

    const { jwtVerify, importJWK } = await import("jose");
    const publicJwk = {
      ...(await exportJWK(keys.publicKey)),
      kid: "full-flow",
      alg: "RS256",
      use: "sig",
    };
    const { payload } = await jwtVerify(
      tokens.access_token,
      await importJWK(publicJwk, "RS256"),
      { issuer: "https://auth.example.test/" },
    );
    assert.equal(
      payload.aud,
      "https://mcp.example.test/mcp",
    );
    assert.ok(
      String(payload.scope ?? "").includes(
        "tetherplane:access",
      ),
    );
    assert.ok(
      typeof payload.exp === "number" &&
        payload.exp * 1000 > Date.now(),
    );

    const refreshed = await fetch(`${address.url}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token ?? "",
        client_id: client.client_id,
      }),
    });
    assert.equal(refreshed.status, 200);

    const replayed = await fetch(
      `${address.url}${consentUrl.pathname}/consent`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type":
            "application/x-www-form-urlencoded",
          accept: "text/html",
          cookie: cookieHeader(jar),
        },
        body: new URLSearchParams({
          csrf: consentCsrf,
        }),
      },
    );
    await replayed.text();
    assert.equal(
      replayed.status,
      400,
      "replaying a finished consent must fail closed",
    );
  } finally {
    await runtime.server.close();
    storage.close();
  }
});

test("returning session completes a second flow without another login", async () => {
  const keys = await generateKeyPair("RS256", {
    extractable: true,
  });
  const privateJwk = {
    ...(await exportJWK(keys.privateKey)),
    kid: "skip-login",
    alg: "RS256",
    use: "sig",
  };
  const databasePath = join(
    mkdtempSync(join(tmpdir(), "tether-skip-login-")),
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
  const jar: Jar = new Map();

  async function runFlow(label: string): Promise<string | null> {
    const challenged =
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const authParams = new URLSearchParams({
      client_id: "unused",
      redirect_uri: "http://127.0.0.1:8765/callback",
      response_type: "code",
      scope: "openid offline_access tetherplane:access",
      code_challenge: challenged,
      code_challenge_method: "S256",
      resource: "https://mcp.example.test/mcp",
      state: label,
    });
    const registered = await fetch(`${address.url}/reg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:8765/callback"],
        client_name: `${label}-client`,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "openid offline_access tetherplane:access",
      }),
    });
    if (registered.status !== 201) {
      return `dcr:${registered.status}`;
    }
    const client = (await registered.json()) as {
      client_id: string;
    };
    authParams.set("client_id", client.client_id);
    const auth = await fetch(
      `${address.url}/auth?${authParams.toString()}`,
      { redirect: "manual" },
    );
    storeCookies(jar, auth);
    if (auth.status !== 302 && auth.status !== 303) {
      return `auth:${auth.status}`;
    }
    let next: URL | null = new URL(
      auth.headers.get("location") ?? "",
      address.url,
    );
    for (let hop = 0; hop < 10 && next; hop += 1) {
      const step: Response = await fetch(next, {
        redirect: "manual",
        headers: {
          accept: "text/html",
          cookie: cookieHeader(jar),
        },
      });
      storeCookies(jar, step);
      if (step.status !== 302 && step.status !== 303) {
        if (
          next.pathname.startsWith("/interaction/") &&
          !next.pathname.endsWith("/consent") &&
          !next.pathname.endsWith("/device-login")
        ) {
          const html = await step.text();
          const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(
            html,
          )?.[1];
          if (!csrf) {
            return `page-no-csrf:${step.status}`;
          }
          const isConsent = html.includes("/consent");
          const target: string = isConsent
            ? `${next.pathname}/consent`
            : `${next.pathname}/device-login`;
          const extra = isConsent
            ? {}
            : { userCode: "ABCD-1234" };
          const posted: Response = await fetch(`${address.url}${target}`, {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type":
                "application/x-www-form-urlencoded",
              accept: "text/html",
              cookie: cookieHeader(jar),
            },
            body: new URLSearchParams({
              csrf,
              ...extra,
            }),
          });
          storeCookies(jar, posted);
          await posted.text();
          if (
            posted.status !== 302 &&
            posted.status !== 303
          ) {
            return `post:${posted.status}`;
          }
          next = new URL(
            posted.headers.get("location") ?? "",
            address.url,
          );
          continue;
        }
        return `hop:${step.status}`;
      }
      next = new URL(
        step.headers.get("location") ?? "",
        address.url,
      );
      if (next.searchParams.has("code")) {
        return null;
      }
    }
    return "no-code";
  }

  try {
    assert.equal(
      await runFlow("first"),
      null,
      "first flow must issue a code",
    );
    assert.equal(
      await runFlow("second"),
      null,
      "returning session must complete without another login",
    );
  } finally {
    await runtime.server.close();
    storage.close();
  }
});
