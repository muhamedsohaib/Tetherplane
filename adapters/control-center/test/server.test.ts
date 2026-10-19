import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import {
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "@tetherplane/relay";
import { ControlCenterServer } from "../src/server.ts";

// Synthetic credentials and ephemeral in-memory devices only; no installed runtime.
async function fixture(t: test.TestContext, ttl = 900_000) {
  let now = Date.now();
  let denied = false;
  const authenticator = new StaticClientAuthenticator([
    {
      token: "fixture-account-a",
      accountId: "account-a",
      clientId: "client-a",
      principalId: "human:a",
    },
    {
      token: "fixture-account-b",
      accountId: "account-b",
      clientId: "client-b",
      principalId: "human:b",
    },
  ]);
  const relay = await RelayServer.create({
    authenticator: {
      authenticate: async (token) =>
        denied ? null : authenticator.authenticate(token),
    },
    allowInsecureLocalhost: true,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  for (const [deviceId, accountId] of [
    ["fixture-a", "account-a"],
    ["fixture-b", "account-b"],
  ]) {
    const pending = await relay.registry.startPairing({
      deviceId: deviceId!,
      credentialHash: hashDeviceCredential("synthetic-device-credential"),
    });
    await relay.registry.approvePairing({
      accountId: accountId!,
      userCode: pending.userCode,
    });
  }
  const portal = new ControlCenterServer({
    relayUrl: address.httpUrl,
    sessionTtlMs: ttl,
    now: () => now,
  });
  const base = await portal.listen({ port: 0 });
  t.after(async () => {
    await portal.close();
    await relay.close();
  });
  async function call(
    path: string,
    options: {
      method?: string;
      cookie?: string;
      csrf?: string;
      body?: unknown;
      origin?: string;
    } = {},
  ) {
    const response = await fetch(base + path, {
      method: options.method ?? "GET",
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.csrf ? { "x-csrf-token": options.csrf } : {}),
        ...(options.method === "POST"
          ? {
              origin: options.origin ?? base,
              "content-type": "application/json",
            }
          : {}),
      },
      ...(options.method !== "POST" || options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    const raw = await response.text();
    return { response, body: raw ? JSON.parse(raw) : null, raw };
  }
  async function login(token = "fixture-account-a") {
    const result = await call("/api/session", {
      method: "POST",
      body: { token },
    });
    assert.equal(result.response.status, 200);
    const cookie = result.response.headers.get("set-cookie")!.split(";")[0]!;
    return { cookie, csrf: result.body.csrfToken as string, ...result };
  }
  return {
    relay,
    portal,
    base,
    call,
    login,
    deny: () => {
      denied = true;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("directory requires a validated session and exposes only account-bound non-secret records", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/devices")).response.status, 401);
  assert.equal(
    (await f.call("/api/session", { method: "POST", body: { token: "wrong" } }))
      .response.status,
    401,
  );
  const a = await f.login();
  assert.match(a.response.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(a.response.headers.get("set-cookie")!, /SameSite=Strict/i);
  assert.equal(a.response.headers.get("cache-control"), "no-store");
  assert.ok(a.body.observedAt);
  assert.equal(a.raw.includes("fixture-account-a"), false);
  assert.equal(a.raw.includes("credentialHash"), false);
  assert.deepEqual(
    a.body.devices.map((d: { deviceId: string }) => d.deviceId),
    ["fixture-a"],
  );
  assert.equal(a.body.devices[0].connectivity, "not_reported");
  assert.equal(a.body.devices[0].version, null);
  const b = await f.login("fixture-account-b");
  const devices = await f.call("/api/devices", b);
  assert.deepEqual(
    devices.body.devices.map((d: { deviceId: string }) => d.deviceId),
    ["fixture-b"],
  );
  assert.equal(
    (await f.call("/api/devices", a)).body.devices[0].deviceId,
    "fixture-a",
  );
});

test("revocation requires CSRF, exact confirmation and fresh account ownership", async (t) => {
  const f = await fixture(t);
  const a = await f.login();
  const path = "/api/devices/fixture-a/revoke";
  assert.equal(
    (
      await f.call(path, {
        method: "POST",
        cookie: a.cookie,
        body: { confirmDeviceId: "fixture-a" },
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await f.call(path, {
        ...a,
        method: "POST",
        body: { confirmDeviceId: "wrong" },
      })
    ).response.status,
    400,
  );
  assert.equal(
    (
      await f.call("/api/devices/fixture-b/revoke", {
        ...a,
        method: "POST",
        body: { confirmDeviceId: "fixture-b" },
      })
    ).response.status,
    403,
  );
  assert.equal(f.relay.registry.getDevice("fixture-a")!.revokedAt, null);
  const revoked = await f.call(path, {
    ...a,
    method: "POST",
    body: { confirmDeviceId: "fixture-a" },
  });
  assert.equal(revoked.response.status, 200);
  assert.notEqual(f.relay.registry.getDevice("fixture-a")!.revokedAt, null);
  assert.equal(
    (await f.call("/api/devices", a)).body.devices[0].revokedAt !== null,
    true,
  );
  assert.equal(f.relay.registry.getDevice("fixture-b")!.revokedAt, null);
});

test("logout and absolute session expiry invalidate access", async (t) => {
  const f = await fixture(t, 1000);
  const a = await f.login();
  assert.equal((await f.call("/api/session", a)).body.csrfToken, a.csrf);
  f.advance(1001);
  assert.equal((await f.call("/api/devices", a)).response.status, 401);
  const b = await f.login();
  assert.equal(
    (await f.call("/api/logout", { ...b, method: "POST" })).response.status,
    200,
  );
  assert.equal((await f.call("/api/devices", b)).response.status, 401);
});

test("cross-origin mutations, missing Origin and hostile Host are rejected", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.call("/api/session", {
        method: "POST",
        origin: "https://attacker.invalid",
        body: { token: "fixture-account-a" },
      })
    ).response.status,
    403,
  );
  const missing = await fetch(f.base + "/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"token":"fixture-account-a"}',
  });
  assert.equal(missing.status, 403);
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      f.base + "/api/session",
      { headers: { host: "attacker.invalid" } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
  const a = await f.login();
  const crossSite = await fetch(f.base + "/api/devices", {
    headers: { cookie: a.cookie, "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSite.status, 403);
});

test("unsupported paths/methods and unsafe body types cannot reach management operations", async (t) => {
  const f = await fixture(t);
  const a = await f.login();
  assert.equal(
    (await f.call("/api/devices/fixture-a/revoke", a)).response.status,
    405,
  );
  assert.equal(
    (await f.call("/api/proxy?url=https://attacker.invalid", a)).response
      .status,
    404,
  );
  const wrongType = await fetch(f.base + "/api/logout", {
    method: "POST",
    headers: {
      origin: f.base,
      cookie: a.cookie,
      "x-csrf-token": a.csrf,
      "content-type": "text/plain",
    },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  const tooLarge = await f.call("/api/session", {
    method: "POST",
    body: { token: "x".repeat(20_000) },
  });
  assert.equal(tooLarge.response.status, 413);
});

test("local static portal is served with restrictive security headers and no arbitrary file access", async (t) => {
  const f = await fixture(t);
  for (const path of [
    "/",
    "/app.js",
    "/style.css",
    "/assets/logo.jpg",
    "/assets/ascii/1.png",
  ]) {
    const response = await fetch(f.base + path);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await fetch(f.base + "/package.json")).status, 404);
  assert.equal((await fetch(f.base + "/%2e%2e/package.json")).status, 404);
  assert.equal((await fetch(f.base + "/constructor")).status, 404);
});

test("upstream credential denial invalidates the local session instead of using cached authority", async (t) => {
  const f = await fixture(t);
  const a = await f.login();
  f.deny();
  const denied = await f.call("/api/devices", a);
  assert.equal(denied.response.status, 401);
  assert.match(denied.response.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal(
    (
      await f.call("/api/devices/fixture-a/revoke", {
        ...a,
        method: "POST",
        body: { confirmDeviceId: "fixture-a" },
      })
    ).response.status,
    401,
  );
  assert.equal(f.relay.registry.getDevice("fixture-a")!.revokedAt, null);
});

test("malformed login bodies and excessive login attempts fail closed", async (t) => {
  const f = await fixture(t);
  for (const token of ["", "space in token", "x\r\ny", 123]) {
    assert.equal(
      (await f.call("/api/session", { method: "POST", body: { token } }))
        .response.status,
      400,
    );
  }
  for (let n = 0; n < 26; n++)
    await f.call("/api/session", { method: "POST", body: { token: "wrong" } });
  assert.equal(
    (
      await f.call("/api/session", {
        method: "POST",
        body: { token: "fixture-account-a" },
      })
    ).response.status,
    429,
  );
  f.advance(60_001);
  assert.equal((await f.login()).body.devices.length, 1);
});
