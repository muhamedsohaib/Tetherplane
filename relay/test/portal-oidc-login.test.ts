import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadPortalOidcLoginConfig,
  parseRelayArgs,
} from "../src/cli-config.ts";
import {
  PortalOidcLogin,
  readPendingCookie,
} from "../src/auth/portal-oidc-login.ts";
import {
  RelayServer,
  StaticClientAuthenticator,
} from "../src/index.ts";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function setup(options: { authToken?: string; identity?: "owner" | "operator" } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-oauth-login-"));
  const clientId = "registered-portal-client";
  const token = options.authToken ?? "valid-owned-access-token";
  const authenticator = new StaticClientAuthenticator([
    {
      token: "valid-owned-access-token",
      accountId: "account-a",
      clientId,
      principalId: "human:account-a",
      role: "owner",
    },
    {
      token: "operator-access-token",
      accountId: "account-a",
      clientId,
      principalId: "operator:external",
      role: "operator",
    },
    {
      token: "other-client-access-token",
      accountId: "account-a",
      clientId: "different-registered-client",
      principalId: "human:account-a",
      role: "owner",
    },
  ]);
  let expectedChallenge = "";
  let tokenRequests = 0;
  const tokenServer = createServer((req, res) => {
    if (req.url !== "/token" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    tokenRequests++;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const verifier = body.get("code_verifier") ?? "";
      const actualChallenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
      if (
        body.get("grant_type") !== "authorization_code" ||
        body.get("client_id") !== clientId ||
        body.get("code") !== "one-time-code" ||
        body.get("resource") !== "http://127.0.0.1:" + (tokenServer.address() as AddressInfo).port + "/mcp" ||
        body.get("redirect_uri") !== "http://127.0.0.1:" + portalPort + "/portal/auth/callback" ||
        expectedChallenge !== actualChallenge
      ) {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_grant"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ token_type: "Bearer", access_token: token, expires_in: 600 }),
      );
    });
  });
  let portalPort = 0;
  let relay: RelayServer | null = null;
  try {
    const authPort = await listen(tokenServer);
    portalPort = await freePort();
    const base = "http://127.0.0.1:" + portalPort;
    const issuer = "http://127.0.0.1:" + authPort + "/";
    const oidc = {
      issuer,
      authorizationEndpoint: issuer + "auth",
      tokenEndpoint: issuer + "token",
      redirectUri: base + "/portal/auth/callback",
      resource: issuer + "mcp",
      clientId,
      scopes: ["openid", "tetherplane:access"],
    };
    relay = await RelayServer.create({
      stateFile: path.join(dir, "devices.json"),
      allowInsecureLocalhost: true,
      authenticator,
      publicOrigin: base,
      trustProxyHeaders: true,
      portalReadOnly: true,
      portalPort,
      portalOidcLogin: oidc,
    });
    const mainAddress = await relay.listen({ host: "127.0.0.1", port: 0 });
    return {
      base,
      mainBase: mainAddress.httpUrl,
      clientId,
      oidc,
      setExpectedChallenge(v: string) { expectedChallenge = v; },
      countRequests() { return tokenRequests; },
      async close() {
        await relay?.close();
        await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (relay) await relay.close();
    if (tokenServer.listening) await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

async function startLogin(base: string) {
  const res = await fetch(base + "/portal/auth/start", { redirect: "manual" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  const location = new URL(res.headers.get("location") ?? "");
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.ok(setCookie.includes("Path=/portal/auth"));
  const cookie = setCookie.split(";")[0]!;
  const state = location.searchParams.get("state");
  assert.equal(readPendingCookie(cookie), state);
  return { location, cookie, state };
}

test("OAuth/PKCE completes only through server-side exchange and creates an opaque HttpOnly session", async () => {
  const f = await setup();
  try {
    const html = await fetch(f.base + "/portal").then((r) => r.text());
    assert.match(html, /data-login-mode="oidc"/);
    assert.match(html, /Sign in with TetherAuth/);
    assert.match(html, /id="token-input" class="hidden"/);
    const pageOnMcp = await fetch(f.mainBase + "/portal");
    assert.equal(pageOnMcp.status, 404);
    const start = await startLogin(f.base);
    assert.equal(start.location.pathname, "/auth");
    assert.equal(start.location.searchParams.get("response_type"), "code");
    assert.equal(start.location.searchParams.get("client_id"), f.clientId);
    assert.equal(start.location.searchParams.get("redirect_uri"), f.oidc.redirectUri);
    assert.equal(start.location.searchParams.get("resource"), f.oidc.resource);
    assert.equal(start.location.searchParams.get("scope"), "openid tetherplane:access");
    assert.equal(start.location.searchParams.get("code_challenge_method"), "S256");
    const challenge = start.location.searchParams.get("code_challenge");
    assert.ok(challenge?.length === 43);
    f.setExpectedChallenge(challenge);
    const callback = await fetch(
      f.base + "/portal/auth/callback?code=one-time-code&state=" + start.state,
      { redirect: "manual", headers: { cookie: start.cookie } },
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/portal");
    const cookies = callback.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.match(cookies[0]!, /Max-Age=0/);
    assert.match(cookies[1]!, /HttpOnly/);
    assert.match(cookies[1]!, /SameSite=Strict/);
    assert.match(cookies[1]!, /Max-Age=600/);
    assert.ok(!cookies.join(" ").includes("valid-owned-access-token"));
    assert.ok(!JSON.stringify(start).includes("valid-owned-access-token"));
    const portalCookie = cookies[1]!.split(";")[0]!;
    const session = await fetch(f.base + "/portal/api/session", {
      headers: { cookie: portalCookie },
    }).then((r) => r.json());
    assert.equal(session.authenticated, true);
    assert.equal(session.ownerPrincipalId, "human:account-a");
    assert.ok(session.csrfToken);
    const overview = await fetch(f.base + "/portal/api/overview", {
      headers: { cookie: portalCookie },
    });
    assert.equal(overview.status, 200);
    assert.equal(f.countRequests(), 1);

    const replay = await fetch(
      f.base + "/portal/auth/callback?code=one-time-code&state=" + start.state,
      { redirect: "manual", headers: { cookie: start.cookie } },
    );
    assert.equal(replay.headers.get("location"), "/portal?login_error=1");
    assert.equal(f.countRequests(), 1, "replayed state must be denied before token exchange");

    const crossSiteStart = await fetch(f.base + "/portal/auth/start", {
      redirect: "manual",
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSiteStart.status, 403);
    const queryBearer = await fetch(f.base + "/portal?access_token=danger");
    assert.equal(queryBearer.status, 400);
  } finally {
    await f.close();
  }
});

test("missing/mismatched OAuth state and operator/client substitution cannot create owner sessions", async () => {
  const f = await setup({ authToken: "operator-access-token" });
  try {
    const start = await startLogin(f.base);
    f.setExpectedChallenge(start.location.searchParams.get("code_challenge")!);
    const wrong = await fetch(
      f.base + "/portal/auth/callback?code=one-time-code&state=" + start.state,
      { redirect: "manual", headers: { cookie: "tetherplane_portal_oidc_state=wrong" } },
    );
    assert.equal(wrong.headers.get("location"), "/portal?login_error=1");
    assert.equal(f.countRequests(), 0);
    const denied = await fetch(
      f.base + "/portal/auth/callback?code=one-time-code&state=" + start.state,
      { redirect: "manual", headers: { cookie: start.cookie } },
    );
    assert.equal(denied.headers.get("location"), "/portal?login_error=1");
    assert.equal(f.countRequests(), 1);
    assert.equal(denied.headers.getSetCookie().length, 1, "non-owner must not receive portal cookie");
    const anon = await fetch(f.base + "/portal/api/session").then((r) => r.json());
    assert.equal(anon.authenticated, false);
  } finally {
    await f.close();
  }
  const g = await setup({ authToken: "other-client-access-token" });
  try {
    const start = await startLogin(g.base);
    g.setExpectedChallenge(start.location.searchParams.get("code_challenge")!);
    const denied = await fetch(
      g.base + "/portal/auth/callback?code=one-time-code&state=" + start.state,
      { redirect: "manual", headers: { cookie: start.cookie } },
    );
    assert.equal(denied.headers.get("location"), "/portal?login_error=1");
    assert.equal(denied.headers.getSetCookie().length, 1);
  } finally {
    await g.close();
  }
});

test("missing sidecar is backwards-compatible; sidecar is fail-closed and private-only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tp-oauth-sidecar-"));
  const state = path.join(dir, "devices.json");
  const file = state + ".portal-oidc-login.json";
  const args = parseRelayArgs([
    "--auth-config", path.join(dir, "auth.json"),
    "--state-file", state,
    "--port", "8788", "--host", "127.0.0.1",
    "--allow-insecure-localhost", "--portal-port", "8789",
    "--portal-read-only", "--public-origin", "https://vaulter.tailf65eba.ts.net:9447",
    "--trust-proxy-headers",
  ]);
  const oauth = {
    issuer: "https://vaulter.tailf65eba.ts.net/",
    resource: "https://vaulter.tailf65eba.ts.net/mcp",
    scopes: ["tetherplane:access"],
  };
  try {
    assert.equal(await loadPortalOidcLoginConfig(args, oauth), undefined);
    await writeFile(file, JSON.stringify({ schema: 1, clientId: "existing-client-123" }));
    const resolved = await loadPortalOidcLoginConfig(args, oauth);
    assert.equal(resolved?.redirectUri, "https://vaulter.tailf65eba.ts.net:9447/portal/auth/callback");
    assert.equal(resolved?.scopes.join(" "), "openid tetherplane:access");
    assert.equal(resolved?.authorizationEndpoint, "https://vaulter.tailf65eba.ts.net/auth");
    assert.equal(resolved?.tokenEndpoint, "https://vaulter.tailf65eba.ts.net/token");
    assert.equal((await loadPortalOidcLoginConfig(args, oauth))?.clientId, "existing-client-123");
    await writeFile(file, "\uFEFF" + JSON.stringify({ schema: 1, clientId: "existing-client-123" }));
    assert.ok(await loadPortalOidcLoginConfig(args, oauth), "Windows UTF-8 BOM must work");
    await writeFile(file, JSON.stringify({ schema: 1, clientId: "existing-client-123", secret: "unsafe" }));
    await assert.rejects(loadPortalOidcLoginConfig(args, oauth), /Invalid portal OAuth login configuration/);
    await writeFile(file, JSON.stringify({ schema: 1, clientId: "existing-client-123" }));
    await assert.rejects(loadPortalOidcLoginConfig({ ...args, portalReadOnly: false }, oauth), /read-only private HTTPS/);
    const { portalPort: _removedPortalPort, ...notSplit } = args;
    await assert.rejects(loadPortalOidcLoginConfig(notSplit, oauth), /read-only private HTTPS/);
    await assert.rejects(loadPortalOidcLoginConfig({ ...args, publicOrigin: "https://vaulter.tailf65eba.ts.net" }, oauth), /read-only private HTTPS/);
    await assert.rejects(loadPortalOidcLoginConfig(args), /read-only private HTTPS/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OIDC configuration rejects external token endpoints, non-PKCE scopes and credentialed URLs", () => {
  const base = {
    issuer: "https://vaulter.tailf65eba.ts.net/",
    authorizationEndpoint: "https://vaulter.tailf65eba.ts.net/auth",
    tokenEndpoint: "https://vaulter.tailf65eba.ts.net/token",
    redirectUri: "https://vaulter.tailf65eba.ts.net:9447/portal/auth/callback",
    resource: "https://vaulter.tailf65eba.ts.net/mcp",
    clientId: "registered-owner-client",
    scopes: ["openid", "tetherplane:access"],
  };
  const auth = new StaticClientAuthenticator([]);
  assert.doesNotThrow(() => new PortalOidcLogin(base, auth));
  assert.throws(() => new PortalOidcLogin({ ...base, tokenEndpoint: "https://evil.example/token" }, auth), /boundaries/);
  assert.throws(() => new PortalOidcLogin({ ...base, authorizationEndpoint: "https://evil.example/auth" }, auth), /boundaries/);
  assert.throws(() => new PortalOidcLogin({ ...base, scopes: ["openid"] }, auth), /boundaries/);
  assert.throws(() => new PortalOidcLogin({ ...base, redirectUri: "http://evil.example/portal/auth/callback" }, auth), /Unsafe/);
  assert.throws(() => new PortalOidcLogin({ ...base, tokenEndpoint: "https://a:secret@vaulter.tailf65eba.ts.net/token" }, auth), /Unsafe/);
});
