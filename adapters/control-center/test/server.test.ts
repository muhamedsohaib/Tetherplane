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
  let hold: (() => Promise<void>) | undefined;
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
      authenticate: async (token) => {
        const wait = hold;
        hold = undefined;
        await wait?.();
        return denied ? null : authenticator.authenticate(token);
      },
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
  async function login(token = "fixture-account-a", previousCookie?: string) {
    const result = await call("/api/session", {
      method: "POST",
      ...(previousCookie ? { cookie: previousCookie } : {}),
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
    holdNext: () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = async () => {
        entered();
        await gate;
      };
      t.after(() => release());
      return { started, release };
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
  assert.equal(a.body.devices[0].connectivity, "relay_disconnected");
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
  assert.equal(denied.response.headers.get("set-cookie"), null);
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

test("idle session cleanup removes authority without another request or clock-prune trigger", async (t) => {
  const f = await fixture(t, 1000);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = await f.login();
  // The injected authorization clock stays frozen: only scheduled cleanup can remove this session.
  t.mock.timers.tick(1001);
  t.mock.timers.reset();
  assert.equal((await f.call("/api/devices", a)).response.status, 401);
});

test("a late invalidated-session response cannot erase a replacement login cookie", async (t) => {
  const f = await fixture(t);
  const a = await f.login();
  const gate = f.holdNext();
  const oldRequest = f.call("/api/devices", a);
  await gate.started;
  const b = await f.login("fixture-account-b", a.cookie);
  gate.release();
  const lateResponse = await oldRequest;
  assert.equal(lateResponse.response.status, 401);
  assert.equal(lateResponse.response.headers.get("set-cookie"), null);
  assert.equal((await f.call("/api/devices", b)).response.status, 200);
});

test("portal approves a device-generated code for its authenticated account and re-pairs after revocation", async (t) => {
  const f = await fixture(t);
  const a = await f.login();
  const start = (secret: string) => f.relay.registry.startPairing({
    deviceId: "fixture-new", credentialHash: hashDeviceCredential(secret),
  });
  const pending = await start("new-synthetic-device-credential");
  const approve = (userCode: string) => f.call("/api/pair/approve", {
    ...a, method: "POST", body: { userCode, confirmOwnership: true },
  });
  const approved = await approve(pending.userCode);
  assert.equal(approved.response.status, 200);
  assert.deepEqual(approved.body, { paired: true, deviceId: "fixture-new" });
  assert.equal(approved.raw.includes(pending.userCode), false);
  assert.equal(approved.raw.includes("accountId"), false);
  assert.equal(approved.raw.includes("credentialHash"), false);
  assert.equal(await f.relay.registry.authenticateDevice("fixture-new", "new-synthetic-device-credential"), "account-a");
  const b = await f.login("fixture-account-b");
  assert.deepEqual((await f.call("/api/devices", b)).body.devices.map((d: {deviceId: string}) => d.deviceId), ["fixture-b"]);
  const directory = await f.call("/api/devices", a);
  assert.equal(directory.body.devices.length, 2);
  assert.equal(directory.body.devices[1].connectivity, "relay_disconnected");
  assert.equal((await approve(pending.userCode)).response.status, 400);
  assert.equal((await f.call("/api/devices/fixture-new/revoke", {
    ...a, method: "POST", body: { confirmDeviceId: "fixture-new" },
  })).response.status, 200);
  assert.equal(await f.relay.registry.authenticateDevice("fixture-new", "new-synthetic-device-credential"), null);
  const fresh = await start("fresh-synthetic-device-credential");
  assert.equal((await approve(fresh.userCode)).response.status, 200);
  assert.equal(await f.relay.registry.authenticateDevice("fixture-new", "fresh-synthetic-device-credential"), "account-a");
  assert.equal(await f.relay.registry.authenticateDevice("fixture-new", "new-synthetic-device-credential"), null);
});

test("pair approval requires a session, same origin, CSRF and explicit possession confirmation", async (t) => {
  const f = await fixture(t);
  const pending = await f.relay.registry.startPairing({ deviceId: "fixture-new", credentialHash: hashDeviceCredential("synthetic-pairing-secret") });
  const body = { userCode: pending.userCode, confirmOwnership: true };
  assert.equal((await f.call("/api/pair/approve", { method: "POST", body })).response.status, 401);
  const a = await f.login();
  assert.equal((await f.call("/api/pair/approve", { cookie: a.cookie, method: "POST", body })).response.status, 403);
  assert.equal((await f.call("/api/pair/approve", { ...a, origin: "https://hostile.invalid", method: "POST", body })).response.status, 403);
  for (const invalid of [
    { userCode: pending.userCode }, { ...body, confirmOwnership: "true" },
    { ...body, userCode: "malformed" }, { ...body, userCode: "A".repeat(1000) },
  ]) assert.equal((await f.call("/api/pair/approve", { ...a, method: "POST", body: invalid })).response.status, 400);
  assert.equal(f.relay.registry.getDevice("fixture-new"), null);
  assert.equal((await f.call("/api/pair/approve", { ...a, method: "POST", body })).response.status, 200);
});

test("logout or expiry during pre-approval authorization prevents the pairing mutation", async (t) => {
  for (const expire of [false, true]) {
    const f = await fixture(t, 1000);
    const a = await f.login();
    const pending = await f.relay.registry.startPairing({ deviceId: "fixture-new", credentialHash: hashDeviceCredential("synthetic-pairing-secret") });
    const gate = f.holdNext();
    const approval = f.call("/api/pair/approve", { ...a, method: "POST", body: { userCode: pending.userCode, confirmOwnership: true } });
    await gate.started;
    if (expire) f.advance(1001);
    else await f.call("/api/logout", { ...a, method: "POST" });
    gate.release();
    assert.equal((await approval).response.status, 401);
    assert.equal(f.relay.registry.getDevice("fixture-new"), null);
  }
});

test("pairing denies expired upstream authority and bounds code guesses across sessions", async (t) => {
  const f = await fixture(t);
  const a = await f.login();
  for (let attempt = 0; attempt < 10; attempt++)
    assert.equal((await f.call("/api/pair/approve", { ...a, method: "POST", body: { userCode: "0000-0000", confirmOwnership: true } })).response.status, 400);
  const b = await f.login();
  assert.equal((await f.call("/api/pair/approve", { ...b, method: "POST", body: { userCode: "0000-0000", confirmOwnership: true } })).response.status, 429);
  f.advance(60_001);
  f.deny();
  assert.equal((await f.call("/api/pair/approve", { ...b, method: "POST", body: { userCode: "0000-0000", confirmOwnership: true } })).response.status, 401);
  assert.equal((await f.call("/api/devices", b)).response.status, 401);
});
