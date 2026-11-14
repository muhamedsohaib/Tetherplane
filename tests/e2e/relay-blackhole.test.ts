import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as connectTcp, createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "@tetherplane/relay";

test("a silently blackholed WebSocket reconnects without restarting or re-pairing the agent", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const temp = await mkdtemp(path.join(os.tmpdir(), "tetherplane-blackhole-"));
  const agentName = "blackhole-test-device";
  const token = "blackhole-test-owner-token";
  const secret = "blackhole-test-device-secret-long-enough";
  const credentialFile = path.join(temp, "device-credential.txt");
  await writeFile(credentialFile, secret, "utf8");

  const relay = await RelayServer.create({
    stateFile: path.join(temp, "devices.json"),
    authenticator: new StaticClientAuthenticator([{
      token,
      accountId: "blackhole-test-owner",
      clientId: "blackhole-test-client",
      principalId: "human:blackhole-test-owner",
    }]),
    allowInsecureLocalhost: true,
    routeTimeoutMs: 3_000,
  });
  const address = await relay.listen({ host: "127.0.0.1", port: 0 });

  const sockets = new Set<Socket>();
  let connections = 0;
  let frozenConnection = 0;
  const proxy = createServer((downstream) => {
    const connectionNumber = ++connections;
    const upstream = connectTcp({ host: "127.0.0.1", port: address.port });
    sockets.add(downstream);
    sockets.add(upstream);
    const forward = () => connectionNumber !== frozenConnection;
    downstream.on("data", (data: Buffer) => {
      if (forward()) upstream.write(data);
    });
    upstream.on("data", (data: Buffer) => {
      if (forward()) downstream.write(data);
    });
    downstream.once("close", () => {
      sockets.delete(downstream);
      upstream.destroy();
    });
    upstream.once("close", () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    downstream.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });

  let child: ChildProcess | null = null;
  let client: Client | null = null;
  const stderr: string[] = [];

  try {
    const started = await jsonPost(address.httpUrl + "/pair/start", {
      deviceId: agentName,
      credentialHash: hashDeviceCredential(secret),
    });
    assert.equal(started.status, 200);
    const approved = await jsonPost(
      address.httpUrl + "/pair/approve",
      { userCode: started.body.userCode },
      token,
    );
    assert.equal(approved.status, 200);

    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", () => {
        proxy.off("error", reject);
        resolve();
      });
    });
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== "string");

    child = spawn(
      path.join(repoRoot, "target", "debug", process.platform === "win32" ? "tetherd.exe" : "tetherd"),
      [
        "--relay-url", "ws://127.0.0.1:" + proxyAddress.port + "/device",
        "--relay-allow-insecure-localhost",
        "--device-id", agentName,
        "--device-credential-file", credentialFile,
        "--allow", temp,
      ],
      { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));

    await until(
      () => relay.router.isOnline(agentName),
      7_000,
      () => assertAgentAlive(child, stderr),
    );
    assert.equal(connections, 1, "initial connection should use only one proxy session");
    const agentPid = child.pid;

    // The client and relay retain an established TCP socket. Neither direction
    // forwards application bytes, simulating a silent network blackhole.
    // New connections are allowed through, so only the agent's watchdog can
    // recover the session without a server-side close frame.
    frozenConnection = 1;
    const blackoutStartedAt = Date.now();

    await until(
      () => connections >= 2,
      30_000,
      () => assertAgentAlive(child, stderr),
    );
    const detectionMs = Date.now() - blackoutStartedAt;
    assert.ok(detectionMs < 30_000, "the stalled connection must recover in under 30s");
    assert.equal(child.pid, agentPid, "reconnection must preserve the agent PID");
    assert.equal(child.exitCode, null, "agent must survive the silent blackhole");

    const transport = new StreamableHTTPClientTransport(new URL(address.mcpUrl), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", "Bearer " + token);
        return fetch(url, { ...init, headers });
      },
    });
    client = new Client({ name: "blackhole-test-client", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport as never);
    const connectedClient = client;
    await until(async () => {
      try {
        const result = await connectedClient.callTool({
          name: "device",
          arguments: { op: "status", device: agentName },
        });
        return result.isError !== true;
      } catch {
        return false;
      }
    }, 10_000, () => assertAgentAlive(child, stderr));

    assert.equal(
      await relay.registry.authenticateDevice(agentName, secret),
      "blackhole-test-owner",
      "the same device credentials remain valid after recovery",
    );
    assert.match(stderr.join(""), /heartbeat pong timed out/, "watchdog should diagnose a missing pong");
  } finally {
    await client?.close().catch(() => undefined);
    if (child && child.exitCode === null) {
      child.kill();
      await once(child, "exit").catch(() => undefined);
    }
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
    await relay.close();
    await rm(temp, { recursive: true, force: true });
  }
});

async function jsonPost(
  url: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  onWait: () => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    onWait();
    if (Date.now() >= deadline) throw new Error("blackhole recovery timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function assertAgentAlive(child: ChildProcess | null, stderr: string[]): void {
  if (!child || child.exitCode === null) return;
  throw new Error("agent exited early: " + stderr.join(""));
}
