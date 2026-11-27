// Row-9 readiness oracle (S3): real tetherd over stdio plus a scriptable
// fake browser bridge. Proves capability readiness is truthful and
// continuously updated: bridge kill -> browser disconnected while the
// device and other namespaces stay healthy; bridge revive -> ready
// again with no restart; degraded sub-service -> degraded.
// Usage: node row9-readiness.mjs [--seeds N] [--seed-offset K]
//   [--tetherd-bin PATH] [--append FILE]
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import net from "node:net";

import { DEFAULT_TETHERD_BIN, sleep, until } from "./harness.mjs";

function parseArgs(argv) {
  const args = { seeds: 1, seedOffset: 0, tetherdBin: DEFAULT_TETHERD_BIN, append: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--seeds") args.seeds = Number(value);
    else if (flag === "--seed-offset") args.seedOffset = Number(value);
    else if (flag === "--tetherd-bin") args.tetherdBin = value;
    else if (flag === "--append") args.append = value;
    else continue;
    i += 1;
  }
  return args;
}

// Fake bridge: handshake + status + snapshot with scriptable modes.
// Modes: healthy | degraded-status | failing-op | dead.
function startFakeBridge() {
  const state = { mode: "healthy", connections: 0 };
  const sockets = new Set();
  let server = null;
  const serve = (socket) => {
    state.connections += 1;
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        socket.write(`${JSON.stringify(reply(request, state.mode))}\n`);
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  };
  const api = {
    state,
    port: 0,
    async listen() {
      // Revives rebind the SAME port: the agent keeps probing the
      // address it was launched with.
      server = net.createServer(serve);
      await new Promise((resolve) => server.listen(api.port, "127.0.0.1", resolve));
      api.port = server.address().port;
    },
    async kill() {
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
    async close() {
      await api.kill().catch(() => undefined);
    },
  };
  return api;
}

function reply(request, mode) {
  if (request.type === "handshake") {
    return {
      request_id: "handshake",
      status: "success",
      data: { protocol_version: "1.0", operations: ["status", "pages", "snapshot"] },
      verification: "not_applicable",
    };
  }
  const capability = request.capability ?? "";
  if (capability === "browser.status") {
    return {
      request_id: request.request_id,
      status: "success",
      data: { available: mode !== "degraded-status", backend: "fake" },
      verification: "not_applicable",
    };
  }
  if (capability === "browser.snapshot" && mode === "failing-op") {
    return {
      request_id: request.request_id,
      status: "error",
      error: { code: "capability_unavailable", message: "snapshot sub-service down", details: {} },
      verification: "failed",
    };
  }
  return {
    request_id: request.request_id,
    status: "success",
    data: { ok: true },
    verification: "not_applicable",
  };
}

function spawnStdioAgent(bin, bridgeAddress) {
  const child = spawn(bin, ["--stdio-rpc", "--browser-bridge", bridgeAddress], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.request_id);
      if (waiter) {
        pending.delete(response.request_id);
        waiter(response);
      }
    }
  });
  child.on("error", () => undefined);
  return {
    child,
    call(capability, args = {}) {
      const requestId = randomUUID();
      const envelope = {
        protocol_version: "1.0",
        request_id: requestId,
        device_id: "lab-device",
        capability,
        arguments: args,
        actor: { id: "fault-lab", kind: "ai_client" },
        session_id: null,
        response_mode: "compact",
        idempotency_key: null,
        preconditions: [],
        expectations: [],
      };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`stdio call ${capability} timed out`));
        }, 10_000);
        pending.set(requestId, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        child.stdin.write(`${JSON.stringify(envelope)}\n`);
      });
    },
    async close() {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

function stateOf(capabilities, namespace) {
  const providers = capabilities?.data?.providers ?? [];
  const entry = providers.find((provider) => provider.namespace === namespace);
  if (!entry) throw new Error(`no capabilities entry for ${namespace}`);
  return entry;
}

async function runSeed(seed, options) {
  const record = { oracle: "row9-readiness", seed, pass: false, phases: {} };
  let bridge = null;
  let agent = null;
  try {
    bridge = startFakeBridge();
    await bridge.listen();
    agent = spawnStdioAgent(options.tetherdBin, `127.0.0.1:${bridge.port}`);
    // Wait for a successful call rather than sleeping: the agent is up
    // when it answers.
    await until(
      async () => {
        try {
          const status = await agent.call("device.status");
          return status.status === "success";
        } catch {
          return false;
        }
      },
      { timeoutMs: 15_000, what: "agent stdio ready" },
    );

    const caps = async () => agent.call("device.capabilities");

    // 1. Healthy baseline: browser ready; Linux desktop disconnected
    // while everything else stays ready (no whole-device outage).
    let providers = await caps();
    record.phases.healthyBrowser = stateOf(providers, "browser").state;
    record.phases.desktopAbsent = stateOf(providers, "desktop").state;
    if (record.phases.healthyBrowser !== "ready") {
      throw new Error(`healthy browser must be ready, saw ${record.phases.healthyBrowser}`);
    }
    if (process.platform !== "win32" && record.phases.desktopAbsent !== "disconnected") {
      throw new Error(`absent desktop must be disconnected, saw ${record.phases.desktopAbsent}`);
    }
    for (const namespace of ["device", "filesystem", "search", "process"]) {
      const state = stateOf(providers, namespace).state;
      if (state !== "ready") throw new Error(`${namespace} must stay ready, saw ${state}`);
    }

    // 2. Kill the bridge: an op fails and the capability reports
    // disconnected while the device itself stays successful.
    await bridge.kill();
    const failed = await agent.call("browser.status");
    if (failed.status !== "error") throw new Error("op against a killed bridge must fail");
    providers = await caps();
    record.phases.killedBrowser = stateOf(providers, "browser").state;
    if (record.phases.killedBrowser !== "disconnected") {
      throw new Error(`killed bridge must report disconnected, saw ${record.phases.killedBrowser}`);
    }
    const statusWhileDown = await agent.call("device.status");
    if (statusWhileDown.status !== "success") {
      throw new Error("device.status must succeed while the bridge is down");
    }

    // 3. Revive: readiness recovers automatically, no restart.
    bridge.state.mode = "healthy";
    await bridge.listen();
    await until(
      async () => (await caps()).data.providers.find((p) => p.namespace === "browser")?.state === "ready",
      { timeoutMs: 10_000, what: "browser recovery" },
    );
    record.phases.revivedBrowser = "ready";

    // 4. Degraded self-report: bridge reachable but unavailable.
    bridge.state.mode = "degraded-status";
    providers = await caps();
    record.phases.degradedBrowser = stateOf(providers, "browser").state;
    if (record.phases.degradedBrowser !== "degraded") {
      throw new Error(`degraded bridge must report degraded, saw ${record.phases.degradedBrowser}`);
    }
    bridge.state.mode = "healthy";
    await until(
      async () => (await caps()).data.providers.find((p) => p.namespace === "browser")?.state === "ready",
      { timeoutMs: 10_000, what: "browser recovery after degraded" },
    );

    // 5. Degraded sub-service: status fine, one op unavailable. The
    // healthy status probe must not conceal the observed failure, and
    // only a succeeding execution heals outcome-observed degradation.
    bridge.state.mode = "failing-op";
    const subFailed = await agent.call("browser.snapshot");
    if (subFailed.status !== "error") throw new Error("failing sub-op must error");
    providers = await caps();
    record.phases.subServiceBrowser = stateOf(providers, "browser").state;
    if (record.phases.subServiceBrowser !== "degraded") {
      throw new Error(`failing sub-service must report degraded, saw ${record.phases.subServiceBrowser}`);
    }
    bridge.state.mode = "healthy";
    const healed = await agent.call("browser.status");
    if (healed.status !== "success") throw new Error("healing op must succeed");
    await until(
      async () => (await caps()).data.providers.find((p) => p.namespace === "browser")?.state === "ready",
      { timeoutMs: 10_000, what: "browser recovery after sub-service failure" },
    );

    record.pass = true;
  } catch (error) {
    record.pass = false;
    record.fail = String(error?.message ?? error);
  } finally {
    if (agent) await agent.close().catch(() => undefined);
    if (bridge) await bridge.close().catch(() => undefined);
  }
  return record;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const records = [];
  for (let i = 0; i < options.seeds; i++) {
    const seed = options.seedOffset + i;
    const record = await runSeed(seed, options);
    records.push(record);
    if (options.append) appendFileSync(options.append, `${JSON.stringify(record)}\n`);
    console.log(
      `seed=${seed} ${record.pass ? "PASS" : "FAIL"} ` +
        `healthy=${record.phases.healthyBrowser ?? "-"} killed=${record.phases.killedBrowser ?? "-"} ` +
        `degraded=${record.phases.degradedBrowser ?? "-"} subsvc=${record.phases.subServiceBrowser ?? "-"} ` +
        (record.pass ? "" : `fail=${record.fail ?? "unknown"}`),
    );
  }
  const passed = records.filter((r) => r.pass).length;
  console.log(`row9-readiness: ${passed}/${records.length} seeds passed`);
  process.exit(passed === records.length ? 0 : 1);
}

await main();
