import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { ControlCenterServer } from "../../adapters/control-center/src/server.ts";
import { RelayServer } from "../src/server.ts";
import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";
import { hashDeviceCredential } from "../src/devices/registry.ts";

// Real local HTTP/WebSocket transports; synthetic device, no installed agent/UI.
test("portal pairing permits authenticated WebSocket reconnect, revocation closes it and only fresh pairing restores access", async (t) => {
  const relay = await RelayServer.create({
    allowInsecureLocalhost: true,
    authenticator: new StaticClientAuthenticator([{ token: "lifecycle-client", accountId: "fixture-account", clientId: "fixture-client", principalId: "human:fixture" }]),
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });
  const portal = new ControlCenterServer({ relayUrl: address.httpUrl });
  const base = await portal.listen({ port: 0 });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await portal.close(); await relay.close();
  });
  const login = await fetch(base + "/api/session", {
    method: "POST", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ token: "lifecycle-client" }),
  });
  assert.equal(login.status, 200);
  const session = await login.json() as { csrfToken: string };
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  async function mutate(path: string, body: unknown) {
    return fetch(base + path, { method: "POST", headers: {
      origin: base, cookie, "x-csrf-token": session.csrfToken, "content-type": "application/json",
    }, body: JSON.stringify(body) });
  }
  async function pair(secret: string) {
    const pending = await fetch(address.httpUrl + "/pair/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "lifecycle-device", credentialHash: hashDeviceCredential(secret) }),
    });
    assert.equal(pending.status, 200);
    const { userCode } = await pending.json() as { userCode: string };
    const approved = await mutate("/api/pair/approve", { userCode, confirmOwnership: true });
    assert.equal(approved.status, 200);
    assert.deepEqual(await approved.json(), { paired: true, deviceId: "lifecycle-device" });
  }
  function connect(secret: string) {
    const socket = new WebSocket(address.deviceWsUrl, { headers: {
      authorization: `Device ${secret}`, "x-tetherplane-device-id": "lifecycle-device",
    } });
    sockets.push(socket);
    return socket;
  }
  const firstSecret = "synthetic-first-lifecycle-device-secret";
  await pair(firstSecret);
  const first = connect(firstSecret);
  await once(first, "open");
  const firstClosed = once(first, "close");
  first.close(); await firstClosed;
  const reconnected = connect(firstSecret);
  await once(reconnected, "open");
  const revokedClosed = once(reconnected, "close");
  assert.equal((await mutate("/api/devices/lifecycle-device/revoke", { confirmDeviceId: "lifecycle-device" })).status, 200);
  await revokedClosed;
  async function rejectOldCredential() {
    const old = connect(firstSecret);
    const status = await new Promise<number>((resolve, reject) => {
      old.once("unexpected-response", (_request, response) => {
        response.resume(); old.terminate(); resolve(response.statusCode!);
      });
      // Termination after the HTTP rejection also emits an error.
      old.on("error", () => {});
      old.once("open", () => reject(new Error("Revoked credential authenticated")));
    });
    assert.equal(status, 401);
  }
  await rejectOldCredential();
  const freshSecret = "synthetic-fresh-lifecycle-device-secret";
  await pair(freshSecret);
  await rejectOldCredential();
  const fresh = connect(freshSecret);
  await once(fresh, "open");
  const directory = await fetch(base + "/api/devices", { headers: { cookie } });
  const view = await directory.json() as { devices: Array<{deviceId: string; revokedAt: string | null; connectivity: string; version: null}> };
  assert.deepEqual(view.devices.map(d => [d.deviceId, d.revokedAt, d.connectivity, d.version]), [["lifecycle-device", null, "not_reported", null]]);
});
