import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "../src/index.ts";

function createAuth(): StaticClientAuthenticator {
  return new StaticClientAuthenticator([
    {
      token: "owner-secret-token-a",
      accountId: "account-a",
      clientId: "portal-owner-a",
      principalId: "human:account-a",
    },
    {
      token: "operator-secret-token-a",
      accountId: "account-a",
      clientId: "assistant-client-a",
      principalId: "operator:assistant-a",
    },
  ]);
}

function extractSessionCookie(headers: Headers): string {
  const rawCookies = headers.getSetCookie?.() ?? [];
  assert.ok(rawCookies.length >= 1, "expected Set-Cookie header");
  const cookieHeader = rawCookies.find((c) =>
    c.startsWith("tetherplane_portal_session="),
  );
  assert.ok(cookieHeader, "expected tetherplane_portal_session cookie");
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  assert.match(cookieHeader, /Path=\/portal/i);
  return cookieHeader.split(";")[0]!;
}

test("GET /portal sets strict CSP & security headers and avoids innerHTML/sessionStorage/URL token sinks", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-sec-html-"));
  const relay = await RelayServer.create({
    authenticator: createAuth(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    const res = await fetch(`${address.httpUrl}/portal`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);

    const csp = res.headers.get("content-security-policy") ?? "";
    assert.ok(csp.length > 0, "expected Content-Security-Policy header");
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(csp, /script-src\s+'sha256-/);
    assert.match(csp, /manifest-src\s+'self'/);
    assert.match(csp, /object-src\s+'none'/);
    assert.match(csp, /frame-ancestors\s+'none'/);

    const html = await res.text();
    assert.match(html, /rel="manifest" href="\/portal\/manifest\.webmanifest"/);
    const manifestRes = await fetch(`${address.httpUrl}/portal/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200);
    assert.match(manifestRes.headers.get("content-type") || "", /application\/manifest\+json/);
    assert.match(manifestRes.headers.get("cache-control") || "", /no-store/);
    assert.equal(manifestRes.headers.get("x-content-type-options"), "nosniff");
    const manifest = await manifestRes.json();
    assert.deepEqual({
      id: manifest.id, start_url: manifest.start_url, scope: manifest.scope,
      display: manifest.display,
    }, { id: "/portal", start_url: "/portal", scope: "/portal", display: "standalone" });
    assert.doesNotMatch(JSON.stringify(manifest), /token|secret|bearer|session/i);
    assert.doesNotMatch(html, /\.innerHTML\b/);
    assert.doesNotMatch(html, /\binsertAdjacentHTML\b/);
    assert.doesNotMatch(html, /\bdocument\.write\b/);
    assert.doesNotMatch(html, /\bsessionStorage\b/);
    assert.doesNotMatch(html, /\blocalStorage\b/);
    assert.doesNotMatch(html, /params\.get\(\s*["']token["']/);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("URL query parameter tokens are rejected on both /portal and /portal/api/*", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-sec-query-"));
  const relay = await RelayServer.create({
    authenticator: createAuth(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    const portalQueryRes = await fetch(
      `${address.httpUrl}/portal?token=owner-secret-token-a`,
    );
    assert.equal(portalQueryRes.status, 400);
    const portalBody = await portalQueryRes.text();
    assert.doesNotMatch(portalBody, /owner-secret-token-a/);

    const apiQueryRes = await fetch(
      `${address.httpUrl}/portal/api/overview?token=owner-secret-token-a`,
    );
    assert.equal(apiQueryRes.status, 400);
    const apiBody = await apiQueryRes.text();
    assert.doesNotMatch(apiBody, /owner-secret-token-a/);

    const hashAccessQuery = await fetch(
      `${address.httpUrl}/portal/api/overview?access_token=owner-secret-token-a`,
    );
    assert.equal(hashAccessQuery.status, 400);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /portal/api/session establishes HttpOnly SameSite=Strict cookie with CSRF and logout revocation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-sec-cookie-"));
  const relay = await RelayServer.create({
    authenticator: createAuth(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    // Pair one device
    const started = await fetch(`${address.httpUrl}/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "CookieDevice",
        credentialHash: hashDeviceCredential("device-secret-cookie-test-123456"),
      }),
    }).then((r) => r.json() as Promise<{ userCode: string }>);
    await fetch(`${address.httpUrl}/pair/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer owner-secret-token-a",
      },
      body: JSON.stringify({ userCode: started.userCode }),
    });

    // Operator cannot establish an owner portal session
    const opSession = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: { authorization: "Bearer operator-secret-token-a" },
    });
    assert.equal(opSession.status, 403);

    // Unauthenticated session check reports authenticated: false without 401
    const anonCheck = await fetch(`${address.httpUrl}/portal/api/session`);
    assert.equal(anonCheck.status, 200);
    const anonJson = (await anonCheck.json()) as { authenticated: boolean };
    assert.equal(anonJson.authenticated, false);

    // Owner exchanges Bearer token for HttpOnly cookie + CSRF token
    const loginRes = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret-token-a" },
    });
    assert.equal(loginRes.status, 200);
    const cookie = extractSessionCookie(loginRes.headers);
    const loginBodyText = await loginRes.text();
    assert.doesNotMatch(loginBodyText, /owner-secret-token-a/);
    const loginBody = JSON.parse(loginBodyText) as {
      authenticated: boolean;
      ownerPrincipalId: string;
      csrfToken: string;
    };
    assert.equal(loginBody.authenticated, true);
    assert.equal(loginBody.ownerPrincipalId, "human:account-a");
    assert.ok(typeof loginBody.csrfToken === "string" && loginBody.csrfToken.length >= 16);

    // Subsequent GET /portal/api/session & GET /portal/api/overview work using ONLY HttpOnly cookie
    const sessionCheck = await fetch(`${address.httpUrl}/portal/api/session`, {
      headers: { cookie },
    });
    assert.equal(sessionCheck.status, 200);
    const sessionCheckJson = (await sessionCheck.json()) as { authenticated: boolean };
    assert.equal(sessionCheckJson.authenticated, true);

    const overviewRes = await fetch(`${address.httpUrl}/portal/api/overview`, {
      headers: { cookie },
    });
    assert.equal(overviewRes.status, 200);
    const overview = (await overviewRes.json()) as { devices: Array<{ deviceId: string }> };
    assert.equal(overview.devices[0]?.deviceId, "CookieDevice");

    // Mutating POST with cookie but NO CSRF header MUST fail with 403
    const missingCsrf = await fetch(
      `${address.httpUrl}/portal/api/devices/CookieDevice/policy`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ revokeFamilies: ["desktop"], reason: "no csrf" }),
      },
    );
    assert.equal(missingCsrf.status, 403);

    // Mutating POST with cookie + CSRF + wrong Origin MUST fail with 403
    const crossOrigin = await fetch(
      `${address.httpUrl}/portal/api/devices/CookieDevice/policy`,
      {
        method: "POST",
        headers: {
          cookie,
          "x-tetherplane-csrf": loginBody.csrfToken,
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ revokeFamilies: ["desktop"], reason: "cross origin" }),
      },
    );
    assert.equal(crossOrigin.status, 403);

    // Mutating POST with cookie + valid CSRF + same-origin succeeds
    const validMutation = await fetch(
      `${address.httpUrl}/portal/api/devices/CookieDevice/policy`,
      {
        method: "POST",
        headers: {
          cookie,
          "x-tetherplane-csrf": loginBody.csrfToken,
          origin: address.httpUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({ revokeFamilies: ["desktop"], reason: "valid cookie mutation" }),
      },
    );
    assert.equal(validMutation.status, 200);

    // Logout invalidates the session server-side and expires cookie
    const logoutRes = await fetch(`${address.httpUrl}/portal/api/session/logout`, {
      method: "POST",
      headers: {
        cookie,
        "x-tetherplane-csrf": loginBody.csrfToken,
        origin: address.httpUrl,
      },
    });
    assert.equal(logoutRes.status, 200);
    const clearedCookies = logoutRes.headers.getSetCookie?.() ?? [];
    assert.ok(clearedCookies.some((c) => /Max-Age=0/i.test(c)));

    const afterLogoutOverview = await fetch(`${address.httpUrl}/portal/api/overview`, {
      headers: { cookie },
    });
    assert.equal(afterLogoutOverview.status, 401);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-3: cookie mutations require Origin/Referer and spoofed X-Forwarded-* headers are ignored without trusted proxy config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-sec-f3-spoof-"));
  const relay = await RelayServer.create({
    authenticator: createAuth(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    const started = await fetch(`${address.httpUrl}/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "F3SpoofDevice",
        credentialHash: hashDeviceCredential("device-secret-f3-spoof-test-1234"),
      }),
    }).then((r) => r.json() as Promise<{ userCode: string }>);
    await fetch(`${address.httpUrl}/pair/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer owner-secret-token-a",
      },
      body: JSON.stringify({ userCode: started.userCode }),
    });

    // Spoofed X-Forwarded-* headers must not mark cookie Secure or authorize attacker Origin
    const spoofOriginSession = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: {
        authorization: "Bearer owner-secret-token-a",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example",
        origin: "https://evil.example",
      },
    });
    assert.equal(spoofOriginSession.status, 403);

    const loginRes = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: {
        authorization: "Bearer owner-secret-token-a",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example",
      },
    });
    assert.equal(loginRes.status, 200);
    const setCookies = loginRes.headers.getSetCookie?.() ?? [];
    assert.equal(setCookies.length, 1);
    assert.doesNotMatch(setCookies[0]!, /;\s*Secure\b/i);
    const cookie = extractSessionCookie(loginRes.headers);
    const { csrfToken } = (await loginRes.json()) as { csrfToken: string };

    // Cookie mutation with valid CSRF but NO Origin and NO Referer must be denied (403)
    const missingOriginAndReferer = await fetch(
      `${address.httpUrl}/portal/api/devices/F3SpoofDevice/policy`,
      {
        method: "POST",
        headers: {
          cookie,
          "x-tetherplane-csrf": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ revokeFamilies: ["desktop"], reason: "no origin/referer" }),
      },
    );
    assert.equal(missingOriginAndReferer.status, 403);

    // Same-origin Referer without Origin succeeds
    const validReferer = await fetch(
      `${address.httpUrl}/portal/api/devices/F3SpoofDevice/policy`,
      {
        method: "POST",
        headers: {
          cookie,
          "x-tetherplane-csrf": csrfToken,
          referer: `${address.httpUrl}/portal`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ revokeFamilies: ["desktop"], reason: "valid referer" }),
      },
    );
    assert.equal(validReferer.status, 200);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-3: configured https publicOrigin behind reverse proxy sets Secure cookies and enforces public Origin", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-sec-f3-proxy-"));

  // trustProxyHeaders without explicit publicOrigin must fail closed
  await assert.rejects(
    RelayServer.create({
      authenticator: createAuth(),
      stateFile: path.join(dir, "bad.json"),
      allowInsecureLocalhost: true,
      trustProxyHeaders: true,
    }),
    /publicOrigin/i,
  );

  const relay = await RelayServer.create({
    authenticator: createAuth(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
    publicOrigin: "https://tether.example",
    trustProxyHeaders: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    const started = await fetch(`${address.httpUrl}/pair/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "F3ProxyDevice",
        credentialHash: hashDeviceCredential("device-secret-f3-proxy-test-1234"),
      }),
    }).then((r) => r.json() as Promise<{ userCode: string }>);
    await fetch(`${address.httpUrl}/pair/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer owner-secret-token-a",
      },
      body: JSON.stringify({ userCode: started.userCode }),
    });

    // Forwarded headers conflicting with configured publicOrigin are rejected
    const downgradedProto = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: {
        authorization: "Bearer owner-secret-token-a",
        origin: "https://tether.example",
        "x-forwarded-proto": "http",
        "x-forwarded-host": "tether.example",
      },
    });
    assert.equal(downgradedProto.status, 403);

    const mismatchedFwdHost = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: {
        authorization: "Bearer owner-secret-token-a",
        origin: "https://tether.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example",
      },
    });
    assert.equal(mismatchedFwdHost.status, 403);

    // Valid proxied login via loopback socket receives Secure + HttpOnly + SameSite=Strict cookie
    const loginRes = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: {
        authorization: "Bearer owner-secret-token-a",
        origin: "https://tether.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "tether.example",
      },
    });
    assert.equal(loginRes.status, 200);
    const setCookies = loginRes.headers.getSetCookie?.() ?? [];
    assert.equal(setCookies.length, 1);
    assert.match(setCookies[0]!, /;\s*Secure\b/i);
    const cookie = extractSessionCookie(loginRes.headers);
    const { csrfToken } = (await loginRes.json()) as { csrfToken: string };

    // Cookie mutation with matching https publicOrigin succeeds even over internal HTTP hop
    const okMutation = await fetch(
      `${address.httpUrl}/portal/api/devices/F3ProxyDevice/policy`,
      {
        method: "POST",
        headers: {
          cookie,
          "x-tetherplane-csrf": csrfToken,
          origin: "https://tether.example",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "tether.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ revokeFamilies: ["desktop"], reason: "proxied https origin" }),
      },
    );
    assert.equal(okMutation.status, 200);

    // Plaintext loopback Origin or mismatched Origin is rejected
    const httpOrigin = await fetch(
      `${address.httpUrl}/portal/api/devices/F3ProxyDevice/policy`,
      {
        method: "POST",
        headers: {
          cookie,
          "x-tetherplane-csrf": csrfToken,
          origin: address.httpUrl,
          "content-type": "application/json",
        },
        body: JSON.stringify({ revokeCapabilities: ["files"], reason: "wrong scheme" }),
      },
    );
    assert.equal(httpOrigin.status, 403);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F-3: https publicOrigin with default trustProxyHeaders=false sets Secure cookies and ignores X-Forwarded-* headers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tether-sec-f3-origin-only-"));
  const relay = await RelayServer.create({
    authenticator: createAuth(),
    stateFile: path.join(dir, "devices.json"),
    allowInsecureLocalhost: true,
    publicOrigin: "https://tether.example",
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  try {
    const loginRes = await fetch(`${address.httpUrl}/portal/api/session`, {
      method: "POST",
      headers: {
        authorization: "Bearer owner-secret-token-a",
        origin: "https://tether.example",
        "x-forwarded-proto": "http",
        "x-forwarded-host": "evil.example",
      },
    });
    assert.equal(loginRes.status, 200);
    const setCookies = loginRes.headers.getSetCookie?.() ?? [];
    assert.equal(setCookies.length, 1);
    assert.match(setCookies[0]!, /;\s*Secure\b/i);
  } finally {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  }
});
