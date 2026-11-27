// Shared harness for row-2 integration oracles (S6).
// Real relay (in-process, loopback) + real tetherd (child) behind a
// scriptable TCP proxy. Temp dirs only; no live devices, no production.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DeviceRegistry, hashDeviceCredential } from "../../relay/src/devices/registry.ts";
import { DeviceRouter } from "../../relay/src/routing/device-router.ts";
import { DeviceWebSocketGateway } from "../../relay/src/devices/ws-gateway.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const DEFAULT_TETHERD_BIN = path.join(REPO_ROOT, "target", "debug", "tetherd");

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function until(predicate, { timeoutMs = 10_000, intervalMs = 25, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${what} after ${timeoutMs} ms`);
    }
    await sleep(intervalMs);
  }
}

export function labIdentity(accountId = "account-a") {
  return { accountId, clientId: "fault-lab", principalId: `human:${accountId}` };
}

export function labInvocation(deviceId, requestId, capability = "device.status", args = {}) {
  return {
    protocol_version: "1.0",
    request_id: requestId,
    principal_id: null,
    device_id: deviceId,
    job_id: null,
    capability,
    arguments: args,
    actor: { id: "fault-lab", kind: "ai_client" },
    session_id: null,
    response_mode: "compact",
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
}

export async function pairedRelay({ secret, deviceId, accountId, heartbeat, routeTimeoutMs = 60_000 }) {
  const registry = await DeviceRegistry.open();
  const pending = await registry.startPairing({
    deviceId,
    credentialHash: hashDeviceCredential(secret),
  });
  await registry.approvePairing({ accountId, userCode: pending.userCode });
  const router = new DeviceRouter({ registry, timeoutMs: routeTimeoutMs });
  const gateway = new DeviceWebSocketGateway({ registry, router, heartbeat });
  const server = createServer();
  gateway.attach(server, "/device");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    registry,
    router,
    gateway,
    server,
    port,
    async close() {
      await gateway.close();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

// Scriptable blackhole proxy: while blackholing, both directions are
// read and dropped (TCP stays open) instead of forwarded. Stats prove
// the fault actually engaged — never a vacuous pass.
export async function startProxy(targetPort) {
  const stats = {
    connections: 0,
    connectionTimes: [],
    agentToRelayForwarded: 0,
    relayToAgentForwarded: 0,
    agentToRelayDropped: 0,
    relayToAgentDropped: 0,
  };
  let blackhole = false;
  const sockets = new Set();
  const server = net.createServer((agentSock) => {
    stats.connections += 1;
    stats.connectionTimes.push(Date.now());
    const relaySock = net.connect(targetPort, "127.0.0.1");
    sockets.add(agentSock);
    sockets.add(relaySock);
    agentSock.on("data", (chunk) => {
      if (blackhole) {
        stats.agentToRelayDropped += chunk.length;
        return;
      }
      stats.agentToRelayForwarded += chunk.length;
      relaySock.write(chunk);
    });
    relaySock.on("data", (chunk) => {
      if (blackhole) {
        stats.relayToAgentDropped += chunk.length;
        return;
      }
      stats.relayToAgentForwarded += chunk.length;
      agentSock.write(chunk);
    });
    const cleanup = () => {
      sockets.delete(agentSock);
      sockets.delete(relaySock);
      agentSock.destroy();
      relaySock.destroy();
    };
    agentSock.on("close", cleanup);
    relaySock.on("close", cleanup);
    agentSock.on("error", () => undefined);
    relaySock.on("error", () => undefined);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    stats,
    setBlackhole(value) {
      blackhole = value;
    },
    async close() {
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export async function rawUpgrade(port, headers) {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const wsKey = randomBytes(16).toString("base64");
  socket.write(
    [
      "GET /device HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${wsKey}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n"),
  );
  let buffer = Buffer.alloc(0);
  while (true) {
    const index = buffer.indexOf("\r\n\r\n");
    if (index >= 0) break;
    const chunk = await new Promise((resolve, reject) => {
      socket.once("data", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("closed before handshake completed")));
    });
    buffer = Buffer.concat([buffer, chunk]);
  }
  const statusLine = buffer.toString("utf8").split("\r\n")[0] ?? "";
  if (!/^HTTP\/1\.1 101/.test(statusLine)) {
    socket.destroy();
    throw new Error(`upgrade rejected: ${statusLine}`);
  }
  socket.on("error", () => undefined);
  return {
    socket,
    closed() {
      if (socket.closed) return Promise.resolve();
      return new Promise((resolve) => socket.once("close", () => resolve()));
    },
    close() {
      socket.destroy();
    },
  };
}

export function spawnAgent({ bin, proxyPort, deviceId, credential }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "faultlab-agent-"));
  const credentialFile = path.join(dir, "credential");
  writeFileSync(credentialFile, credential);
  const child = spawn(
    bin,
    [
      "--relay-url",
      `ws://127.0.0.1:${proxyPort}/device`,
      "--device-id",
      deviceId,
      "--device-credential-file",
      credentialFile,
      "--relay-allow-insecure-localhost",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines = [];
  const exit = { code: null, signal: null, t: null };
  const pump = (stream, name) => {
    let pending = "";
    stream.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (line) lines.push({ t: Date.now(), stream: name, line });
      }
    });
  };
  pump(child.stdout, "out");
  pump(child.stderr, "err");
  child.on("exit", (code, signal) => {
    exit.code = code;
    exit.signal = signal;
    exit.t = Date.now();
  });
  child.on("error", () => undefined);
  return {
    child,
    pid: child.pid,
    lines,
    exit,
    async waitForLine(predicate, timeoutMs, what) {
      await until(() => lines.some((entry) => predicate(entry.line)), {
        timeoutMs,
        what,
      });
      return lines.find((entry) => predicate(entry.line));
    },
    async kill() {
      if (exit.t === null) {
        child.kill("SIGTERM");
        const deadline = Date.now() + 5_000;
        while (exit.t === null && Date.now() < deadline) {
          await sleep(25);
        }
        if (exit.t === null) child.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function relayRssKb() {
  return Math.round(process.memoryUsage().rss / 1024);
}

export async function agentRssKb(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
