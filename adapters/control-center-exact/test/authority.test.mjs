// Use actual relay control HTTP and owner authority, without any production
// OAuth endpoint, agent, user HTML, or external WebSocket dependency.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ExactPortal } from "../server.mjs";
import { StaticClientAuthenticator } from "../../../relay/src/auth/static-auth.ts";
import { OwnerDeviceAuthority } from "../../../relay/src/access/owner-authority.ts";
import { RelayControlHttpGateway } from "../../../relay/src/devices/control-http.ts";
import { DeviceRegistry, hashDeviceCredential } from "../../../relay/src/devices/registry.ts";

const owner = {
  accountId: "qa-account",
  clientId: "https://chatgpt.com/oauth/approved-owner/client.json",
  principalId: "human:owner",
};
const chat = {
  accountId: "qa-account",
  clientId: "https://chatgpt.com/oauth/chat-client.json",
  principalId: "human:operator",
};

async function listener(t, authorityEnabled = true) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "tp-authority-portal-"));
  const registry = await DeviceRegistry.open();
  const code = await registry.startPairing({
    deviceId: "Surface",
    credentialHash: hashDeviceCredential("synthetic-non-production-credential-for-test"),
  });
  await registry.approvePairing({ accountId: owner.accountId, userCode: code.userCode });
  const authority = authorityEnabled
    ? await OwnerDeviceAuthority.open({
      owner, registry, stateFile: path.join(folder, "owner-authority.json"),
    })
    : null;
  const authenticator = new StaticClientAuthenticator([
    { ...owner, token: "synthetic-owner-control-token" },
    { ...chat, token: "synthetic-chat-control-token" },
  ]);
  const gateway = new RelayControlHttpGateway({
    registry, authority, authenticator, disconnectDevice() {},
  });
  const server = createServer();
  gateway.attach(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const relayOrigin = "http://127.0.0.1:" + server.address().port;
  const portal = new ExactPortal({
    relayUrl: relayOrigin,
    htmlPath: fileURLToPath(new URL("./fixture.html", import.meta.url)),
  });
  const origin = await portal.listen(0);
  t.after(async () => {
    await portal.close();
    gateway.close();
    await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await rm(folder, { recursive: true, force: true });
  });
  async function raw(route, { method = "GET", body, cookie, csrf, originHeader = true } = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: {
        ...(originHeader && ["POST", "PUT"].includes(method) ? { origin } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie"),
    };
  }
  async function login(token) {
    const v = await raw("/api/session", { method: "POST", body: { token } });
    assert.equal(v.status, 200);
    return { cookie: v.cookie.split(";")[0], csrf: v.data.csrfToken };
  }
  return { raw, login, authority };
}

test("exact portal: owner access is bound to OAuth client, CSRF, revision and typed approval", async t => {
  const h = await listener(t);
  const own = await h.login("synthetic-owner-control-token");
  const other = await h.login("synthetic-chat-control-token");
  assert.equal((await h.raw("/api/authority")).status, 401);
  assert.equal((await h.raw("/api/authority", other)).status, 403);
  const initial = await h.raw("/api/authority", own);
  assert.equal(initial.status, 200);
  assert.equal(initial.data.enabled, false);
  assert.equal(initial.data.revision, 0);
  assert.ok(!JSON.stringify(initial.data).includes("synthetic-owner-control-token"));

  const grant = { deviceId: "Surface", clientId: chat.clientId, principalId: chat.principalId, level: "observe" };
  const edit = { method: "PUT", body: { revision: 0, grants: [grant] }, ...own };
  assert.equal((await h.raw("/api/authority/grants", { ...edit, csrf: null })).status, 403);
  assert.equal((await h.raw("/api/authority/grants", { ...edit, originHeader: false })).status, 403);
  assert.equal((await h.raw("/api/authority/grants", { ...edit, ...other })).status, 403);
  const staged = await h.raw("/api/authority/grants", edit);
  assert.equal(staged.status, 200);
  assert.equal(staged.data.revision, 1);
  assert.equal((await h.raw("/api/authority/grants", edit)).status, 409);

  const wrongPhrase = await h.raw("/api/authority/enforcement", {
    method: "POST", body: { revision: 1, enabled: true, confirmation: "YES" }, ...own,
  });
  assert.equal(wrongPhrase.status, 400);
  assert.equal(wrongPhrase.data.error.code, "invalid_arguments");
  assert.equal(h.authority.snapshot(owner).enabled, false);
  const enabled = await h.raw("/api/authority/enforcement", {
    method: "POST", body: { revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS" }, ...own,
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.enabled, true);
  const result = await h.raw("/api/authority", own);
  assert.equal(result.data.revision, 2);
  assert.equal(result.data.grants[0].clientId, chat.clientId);
  assert.equal((await h.raw("/api/authority", other)).status, 403);
});

test("exact portal: legacy relay does not implicitly create an owner authority policy", async t => {
  const h = await listener(t, false);
  const own = await h.login("synthetic-owner-control-token");
  const denied = await h.raw("/api/authority", own);
  assert.equal(denied.status, 503);
  assert.equal(denied.data.error.code, "authority_unavailable");
});
