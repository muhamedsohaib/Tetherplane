import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";
import { DeviceRegistry } from "../src/devices/registry.ts";
import { DeviceRouter } from "../src/routing/device-router.ts";
import { RemoteMcpHttpGateway } from "../src/mcp/http-gateway.ts";

const oauth = {
  resource: "https://relay.example/mcp",
  issuer: "https://identity.example/",
  scopes: ["tetherplane:access"],
};

const OWNER = {
  token: "owner-bearer-token",
  accountId: "account-owner",
  clientId: "client-owner",
  principalId: "human:owner",
};
const OTHER = {
  token: "other-bearer-token",
  accountId: "account-other",
  clientId: "client-other",
  principalId: "human:other",
};

const CREDENTIAL = "TEST-DEVICE-CREDENTIAL-ABCDEFGHIJKLMNOP";
const DEVICE = "TestPC01";

type Fixture = {
  registry: DeviceRegistry;
  gateway: RemoteMcpHttpGateway;
  server: import("node:http").Server;
  hash: string;
  approveCall: (
    id: number,
    args: Record<string, unknown>,
    authorization?: string,
    session?: string,
    extraArguments?: Record<string, unknown>,
  ) => Promise<Response>;
  rawCall: (
    id: number,
    outerArguments: Record<string, unknown>,
    authorization?: string,
  ) => Promise<Response>;
  discover: (authorization?: string) => Promise<string>;
};

async function makeFixture(pairingTtlMs?: number): Promise<Fixture> {
  const registry = await DeviceRegistry.open(
    pairingTtlMs === undefined ? {} : { pairingTtlMs },
  );
  const router = new DeviceRouter({ registry });
  router.call = async () => {
    throw new Error("approval must never route to a device");
  };
  const authenticator = new StaticClientAuthenticator([OWNER, OTHER]);
  const gateway = new RemoteMcpHttpGateway({ router, authenticator, oauth });
  const server = createServer();
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown, session?: string, authorization?: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2_000),
    });
  const approveCall: Fixture["approveCall"] = (
    id,
    args,
    authorization?,
    session?,
    extraArguments?,
  ) =>
    post(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "device",
          arguments: {
            op: "approve_pairing",
            args,
            response_mode: "normal",
            ...(extraArguments ?? {}),
          },
        },
      },
      session,
      authorization,
    );
  const rawCall: Fixture["rawCall"] = (id, outerArguments, authorization?) =>
    post(
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "device", arguments: outerArguments },
      },
      undefined,
      authorization,
    );
  const discover = async (authorization?: string) => {
    const response = await post(
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "approve-test", version: "1" },
        },
      },
      undefined,
      authorization,
    );
    assert.equal(response.status, 200);
    const session = response.headers.get("mcp-session-id");
    assert.ok(session);
    return session;
  };
  const { hashDeviceCredential } = await import("../src/devices/registry.ts");
  return {
    registry,
    gateway,
    server,
    hash: hashDeviceCredential(CREDENTIAL),
    approveCall,
    rawCall,
    discover,
  };
}

async function close(fixture: Fixture) {
  await fixture.gateway.close();
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
}

type CallResult = {
  result: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type: string; text: string }>;
  };
};

test("authenticated approval binds the session account without routing to a device", async () => {
  const f = await makeFixture();
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    const response = await f.approveCall(
      1,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as CallResult;
    assert.equal(body.result.isError, undefined);
    assert.deepEqual(body.result.structuredContent, {
      paired: true,
      device_id: DEVICE,
      account_id: OWNER.accountId,
    });
    assert.ok(!JSON.stringify(body).includes(f.hash));
    const binding = f.registry.getDevice(DEVICE);
    assert.equal(binding?.accountId, OWNER.accountId);
  } finally {
    await close(f);
  }
});

test("approval ignores account and principal overrides from both envelopes", async () => {
  const f = await makeFixture();
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    const response = await f.approveCall(
      1,
      {
        userCode: started.userCode,
        expectedDeviceId: DEVICE,
        accountId: OTHER.accountId,
        principalId: OTHER.principalId,
      },
      `Bearer ${OWNER.token}`,
      undefined,
      { accountId: OTHER.accountId, device: "SomeOtherPC" },
    );
    assert.equal(response.status, 200);
    const binding = f.registry.getDevice(DEVICE);
    assert.equal(binding?.accountId, OWNER.accountId);
  } finally {
    await close(f);
  }
});

test("anonymous approval is rejected and the code stays pending", async () => {
  const f = await makeFixture();
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    const denied = await f.approveCall(1, {
      userCode: started.userCode,
      expectedDeviceId: DEVICE,
    });
    assert.equal(denied.status, 200);
    const deniedBody = (await denied.json()) as CallResult;
    assert.equal(deniedBody.result.isError, true);
    const retry = await f.approveCall(
      2,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
    );
    const retryBody = (await retry.json()) as CallResult;
    assert.equal(retryBody.result.isError, undefined);
    assert.equal(f.registry.getDevice(DEVICE)?.accountId, OWNER.accountId);
  } finally {
    await close(f);
  }
});

test("invalid bearer is rejected without consuming the code", async () => {
  const f = await makeFixture();
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    const denied = await f.approveCall(
      1,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      "Bearer forged-bearer-token",
    );
    const deniedBody = (await denied.json()) as CallResult;
    assert.equal(deniedBody.result.isError, true);
    const retry = await f.approveCall(
      2,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
    );
    const retryBody = (await retry.json()) as CallResult;
    assert.equal(retryBody.result.isError, undefined);
    assert.equal(f.registry.getDevice(DEVICE)?.accountId, OWNER.accountId);
  } finally {
    await close(f);
  }
});

test("unknown session fails closed without consuming the code", async () => {
  const f = await makeFixture();
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    const unknown = await f.approveCall(
      1,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
      "no-such-session-id",
    );
    assert.equal(unknown.status, 404);
    const retry = await f.approveCall(
      2,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
    );
    const retryBody = (await retry.json()) as CallResult;
    assert.equal(retryBody.result.isError, undefined);
    assert.equal(f.registry.getDevice(DEVICE)?.accountId, OWNER.accountId);
  } finally {
    await close(f);
  }
});

test("a session bound to one account rejects use by another account", async () => {
  const f = await makeFixture();
  try {
    const session = await f.discover(`Bearer ${OWNER.token}`);
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    const mismatch = await f.approveCall(
      1,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OTHER.token}`,
      session,
    );
    assert.equal(mismatch.status, 403);
    const retry = await f.approveCall(
      2,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
      session,
    );
    const retryBody = (await retry.json()) as CallResult;
    assert.equal(retryBody.result.isError, undefined);
    assert.equal(f.registry.getDevice(DEVICE)?.accountId, OWNER.accountId);
  } finally {
    await close(f);
  }
});

test("malformed nested args fail without consuming the code", async () => {
  const f = await makeFixture();
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    const shapes: Record<string, unknown>[] = [
      {},
      { userCode: started.userCode },
      { expectedDeviceId: DEVICE },
      { userCode: 12345, expectedDeviceId: DEVICE },
      { userCode: started.userCode, expectedDeviceId: null },
    ];
    let id = 1;
    for (const args of shapes) {
      const response = await f.approveCall(id++, args, `Bearer ${OWNER.token}`);
      const body = (await response.json()) as CallResult;
      assert.equal(body.result.isError, true);
    }
    for (const outer of [
      { op: "approve_pairing", response_mode: "normal" },
      { op: "approve_pairing", args: null, response_mode: "normal" },
      { op: "approve_pairing", args: [], response_mode: "normal" },
      { op: "approve_pairing", args: "ABCD-1234", response_mode: "normal" },
    ]) {
      const raw = await f.rawCall(id++, outer, `Bearer ${OWNER.token}`);
      const body = (await raw.json()) as CallResult;
      assert.equal(body.result.isError, true);
    }
    const retry = await f.approveCall(
      99,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
    );
    const retryBody = (await retry.json()) as CallResult;
    assert.equal(retryBody.result.isError, undefined);
    assert.equal(f.registry.getDevice(DEVICE)?.accountId, OWNER.accountId);
  } finally {
    await close(f);
  }
});

test("expired codes fail without pairing", async () => {
  const f = await makeFixture(1);
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const response = await f.approveCall(
      1,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as CallResult;
    assert.equal(body.result.isError, true);
    assert.equal(f.registry.getDevice(DEVICE), null);
  } finally {
    await close(f);
  }
});

test("reused codes fail on the second approval", async () => {
  const f = await makeFixture();
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    const first = await f.approveCall(
      1,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
    );
    assert.equal(first.status, 200);
    const second = await f.approveCall(
      2,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
    );
    const body = (await second.json()) as CallResult;
    assert.equal(body.result.isError, true);
    assert.equal(f.registry.getDevice(DEVICE)?.accountId, OWNER.accountId);
  } finally {
    await close(f);
  }
});

test("wrong expected device fails closed and preserves the pending code", async () => {
  const f = await makeFixture();
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    const wrong = await f.approveCall(
      1,
      { userCode: started.userCode, expectedDeviceId: "SomeOtherPC" },
      `Bearer ${OWNER.token}`,
    );
    const wrongBody = (await wrong.json()) as CallResult;
    assert.equal(wrongBody.result.isError, true);
    const retry = await f.approveCall(
      2,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
    );
    const retryBody = (await retry.json()) as CallResult;
    assert.equal(retryBody.result.isError, undefined);
    assert.equal(f.registry.getDevice(DEVICE)?.accountId, OWNER.accountId);
  } finally {
    await close(f);
  }
});

test("approval binds strictly to the calling session account", async () => {
  const f = await makeFixture();
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    const response = await f.approveCall(
      1,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OTHER.token}`,
    );
    assert.equal(response.status, 200);
    assert.equal(f.registry.getDevice(DEVICE)?.accountId, OTHER.accountId);
  } finally {
    await close(f);
  }
});

test("starting a pairing while paired keeps the existing binding", async () => {
  const f = await makeFixture();
  try {
    const started = await f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash });
    await f.approveCall(
      1,
      { userCode: started.userCode, expectedDeviceId: DEVICE },
      `Bearer ${OWNER.token}`,
    );
    await assert.rejects(
      f.registry.startPairing({ deviceId: DEVICE, credentialHash: f.hash }),
      /already paired/,
    );
    assert.equal(f.registry.getDevice(DEVICE)?.accountId, OWNER.accountId);
  } finally {
    await close(f);
  }
});
