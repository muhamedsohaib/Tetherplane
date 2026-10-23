// Owner-only Control Center authority against the actual relay HTTP gateway.
// No live VAULTER, OAuth registration, production token, or owner private HTML.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ExactPortal } from "../server.mjs";
import { RelayServer } from "../../../relay/src/server.ts";
import { StaticClientAuthenticator } from "../../../relay/src/auth/static-auth.ts";
import { hashDeviceCredential } from "../../../relay/src/devices/registry.ts";

const owner = { accountId: "qa-account", clientId: "https://chatgpt.com/oauth/approved-owner/client.json", principalId: "human:owner" };
const chat = { accountId: "qa-account", clientId: "https://chatgpt.com/oauth/chat-client.json", principalId: "human:operator" };

test("real portal owner access requires exact client identity, CSRF, staged grant and typed enforcement", async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tp-owner-portal-"));
  const relay = await RelayServer.create({
    allowInsecureLocalhost: true,
    authenticator: new StaticClientAuthenticator([
      { ...owner, token: "synthetic-owner-control-token" },
      { ...chat, token: "synthetic-chat-control-token" },
    ]),
    authority: { owner, stateFile: path.join(tmp, "authority.json") },
  });
  const relayUrl = (await relay.listen({ host: "127.0.0.1", port: 0 })).httpUrl;
  const code = await relay.registry.startPairing({
    deviceId: "Surface", credentialHash: hashDeviceCredential("synthetic-valid-device-credential-for-owner-QA"),
  });
  await relay.registry.approvePairing({ accountId: owner.accountId, userCode: code.userCode });
  const portal = new ExactPortal({
    relayUrl,
    htmlPath: fileURLToPath(new URL("./fixture.html", import.meta.url)),
  });
  const origin = await portal.listen(0);
  t.after(async () => {
    await portal.close(); await relay.close();
    await rm(tmp, { recursive: true, force: true });
  });
  async function raw(route, { method = "GET", body, cookie, csrf, originHeader = true } = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: {
        ...(originHeader && (method === "POST" || method === "PUT") ? { origin } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") };
  }
  async function login(token) {
    const v = await raw("/api/session", { method: "POST", body: { token } });
    assert.equal(v.status, 200);
    return { cookie: v.cookie.split(";")[0], csrf: v.data.csrfToken };
  }
  const own = await login("synthetic-owner-control-token");
  const other = await login("synthetic-chat-control-token");
  assert.equal((await raw("/api/authority")).status, 401);
  assert.equal((await raw("/api/authority", other)).status, 403);
  const initial = await raw("/api/authority", own);
  assert.equal(initial.status, 200);
  assert.equal(initial.data.enabled, false);
  assert.equal(initial.data.revision, 0);
  assert.ok(!JSON.stringify(initial.data).includes("synthetic-owner-control-token"));
  const grant = { deviceId: "Surface", clientId: chat.clientId, principalId: chat.principalId, level: "observe" };
  const edit = { method: "PUT", body: { revision: 0, grants: [grant] }, ...own };
  assert.equal((await raw("/api/authority/grants", { ...edit, csrf: null })).status, 403, "CSRF required for PUT");
  assert.equal((await raw("/api/authority/grants", { ...edit, originHeader: false })).status, 403);
  assert.equal((await raw("/api/authority/grants", { ...edit, ...other })).status, 403);
  const staged = await raw("/api/authority/grants", edit);
  assert.equal(staged.status, 200);
  assert.equal(staged.data.revision, 1);
  assert.equal((await raw("/api/authority/grants", edit)).status, 409, "stale edit rejected");
  assert.equal((await raw("/api/authority/enforcement", {
    method: "POST", body: { revision: 1, enabled: true, confirmation: "YES" }, ...own,
  })).status, 400);
  const activated = await raw("/api/authority/enforcement", {
    method: "POST", body: { revision: 1, enabled: true, confirmation: "ENFORCE DEVICE GRANTS" }, ...own,
  });
  assert.equal(activated.status, 200);
  assert.equal(activated.data.enabled, true);
  assert.equal((await raw("/api/authority", own)).data.grants[0].clientId, chat.clientId);
  assert.equal((await raw("/api/authority", own)).data.revision, 2);
  assert.equal((await raw("/api/authority", other)).status, 403, "different OAuth client cannot access owner panel");

  const denied = await raw("/api/mcp/call", {
    method: "POST", body: { tool: "process", op: "run", device: "Surface", args: { program: "synthetic-no-execution" } }, ...other,
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.data.result.isError, true);
  assert.equal(denied.data.result.structuredContent.error.code, "disconnected",
    "without a device socket, the offline transport denial remains separate from access grant");
});

test("authority is not installed implicitly on legacy relay and cannot be created by a random OAuth client", async t => {
  const relay = await RelayServer.create({
    allowInsecureLocalhost: true,
    authenticator: new StaticClientAuthenticator([{ ...chat, token: "synthetic-chat-token-legacy" }]),
  });
  const base = (await relay.listen({ host: "127.0.0.1", port: 0 })).httpUrl;
  t.after(async () => { await relay.close(); });
  const status = await fetch(base + "/authority", {
    headers: { authorization: "Bearer synthetic-chat-token-legacy" },
  });
  assert.equal(status.status, 404);
});
