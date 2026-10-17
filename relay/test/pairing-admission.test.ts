import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { randomBytes } from "node:crypto";

import { RelayControlHttpGateway } from "../src/devices/control-http.ts";
import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";
import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";

test("pair start limits one socket source, ignores spoofed forwarding, and admits another source", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const registry = await DeviceRegistry.open();
  const gateway = new RelayControlHttpGateway({
    registry, authenticator: new StaticClientAuthenticator([]), disconnectDevice() {},
    pairingStartRateLimit: { maxRequests: 2, windowMs: 1000, maxSources: 2 },
  } as ConstructorParameters<typeof RelayControlHttpGateway>[0]);
  const server = createServer();
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let next = 0;
  const start = (localAddress: string, forwarded?: string) => new Promise<{ status: number; retry: string | undefined; body: string }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path: "/pair/start", method: "POST", localAddress,
      headers: { "content-type": "application/json", ...(forwarded ? { "x-forwarded-for": forwarded } : {}) },
      timeout: 2000,
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += String(chunk); });
      response.on("end", () => resolve({ status: response.statusCode!, retry: response.headers["retry-after"] as string | undefined, body }));
    });
    req.on("timeout", () => req.destroy(new Error("fixture request timed out")));
    req.on("error", reject);
    req.end(JSON.stringify({ deviceId: "Admission" + next++, credentialHash: hashDeviceCredential(randomBytes(32).toString("hex")) }));
  });
  try {
    assert.equal((await start("127.0.0.1")).status, 200);
    assert.equal((await start("127.0.0.1")).status, 200);
    const denied = await start("127.0.0.1", "127.0.0.99");
    assert.equal(denied.status, 429);
    assert.equal(denied.retry, "1");
    assert.equal((await start("127.0.0.2")).status, 200);
    assert.equal((await start("127.0.0.3")).status, 429, "source tracking capacity is bounded");
    t.mock.timers.tick(1001);
    assert.equal((await start("127.0.0.3")).status, 200);
  } finally {
    gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close?.();
  }
});
