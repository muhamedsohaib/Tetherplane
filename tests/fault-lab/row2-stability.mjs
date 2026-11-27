// Row-2 stability oracle (S6): healthy real agent + real relay must
// survive a long-running provider operation and sustained heartbeats
// with no retire, no reconnect, and bounded resource growth.
// Usage: node row2-stability.mjs [--seeds N] [--seed-offset K]
//   [--tetherd-bin PATH] [--append FILE]
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import {
  DEFAULT_TETHERD_BIN,
  agentRssKb,
  labIdentity,
  labInvocation,
  pairedRelay,
  relayRssKb,
  sleep,
  spawnAgent,
  startProxy,
  until,
} from "./harness.mjs";

function parseArgs(argv) {
  const args = {
    seeds: 3,
    seedOffset: 0,
    tetherdBin: DEFAULT_TETHERD_BIN,
    append: null,
  };
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

async function runSeed(seed, options) {
  const deviceId = "lab-device";
  const accountId = "account-a";
  const secret = `lab-stability-credential-${seed}-x`;
  const record = { oracle: "row2-stability", seed, pass: false };
  let relay = null;
  let proxy = null;
  let agent = null;
  try {
    relay = await pairedRelay({
      secret,
      deviceId,
      accountId,
      heartbeat: { intervalMs: 25, staleMs: 100 },
      routeTimeoutMs: 60_000,
    });
    proxy = await startProxy(relay.port);
    agent = spawnAgent({
      bin: options.tetherdBin,
      proxyPort: proxy.port,
      deviceId,
      credential: secret,
    });
    await until(() => relay.router.isOnline(deviceId), {
      timeoutMs: 15_000,
      what: "agent online",
    });
    record.rssRelayBeforeKb = relayRssKb();
    record.rssAgentBeforeKb = await agentRssKb(agent.pid);

    // Long-running provider operation through the real stack: the
    // relay must keep the connection while the agent is busy.
    const slowStarted = Date.now();
    const slowId = randomUUID();
    const slow = await relay.router.call(
      labIdentity(accountId),
      labInvocation(deviceId, slowId, "process.run", {
        program: "sleep",
        args: ["8"],
        wait_ms: 9_000,
      }),
    );
    record.slowOpMs = Date.now() - slowStarted;
    if (slow.status !== "success" || slow.request_id !== slowId) {
      throw new Error(`slow op failed: ${JSON.stringify(slow)}`);
    }
    if (record.slowOpMs < 7_000) {
      throw new Error(`slow op returned in ${record.slowOpMs} ms; not actually long`);
    }

    // Sustained heartbeats with periodic calls; presence must never flap.
    let offlineSamples = 0;
    let callsOk = 0;
    const windowMs = 12_000;
    const windowStart = Date.now();
    let nextCallAt = windowStart;
    let callIndex = 0;
    while (Date.now() - windowStart < windowMs) {
      if (!relay.router.isOnline(deviceId)) offlineSamples += 1;
      if (Date.now() >= nextCallAt) {
        const callId = randomUUID();
        const result = await relay.router.call(
          labIdentity(accountId),
          labInvocation(deviceId, callId),
        );
        if (result.status === "success" && result.request_id === callId) callsOk += 1;
        callIndex += 1;
        nextCallAt += 3_000;
      }
      await sleep(100);
    }
    record.offlineSamples = offlineSamples;
    record.steadyCallsOk = callsOk;
    record.steadyCallsTotal = callIndex;
    if (offlineSamples !== 0) {
      throw new Error(`presence flapped ${offlineSamples} samples during stability window`);
    }
    if (callsOk !== callIndex || callIndex < 3) {
      throw new Error(`only ${callsOk}/${callIndex} steady calls succeeded`);
    }
    // Heartbeats provably flowed the whole window (anti-vacuity):
    // ~40 pings/s relay->agent at ~40 bytes each.
    record.relayToAgentBytes = proxy.stats.relayToAgentForwarded;
    if (record.relayToAgentBytes < 10_000) {
      throw new Error(`only ${record.relayToAgentBytes} relay->agent bytes; heartbeats did not flow`);
    }
    const reconnects = agent.lines.filter((entry) => entry.line.includes("relay connection lost"));
    record.agentReconnects = reconnects.length;
    if (reconnects.length !== 0) {
      throw new Error(`agent reconnected during stability: ${JSON.stringify(reconnects[0])}`);
    }
    record.rssRelayAfterKb = relayRssKb();
    record.rssAgentAfterKb = await agentRssKb(agent.pid);
    for (const [before, after, name] of [
      [record.rssRelayBeforeKb, record.rssRelayAfterKb, "relay"],
      [record.rssAgentBeforeKb, record.rssAgentAfterKb, "agent"],
    ]) {
      if (typeof before === "number" && typeof after === "number" && after > before * 1.5 + 5_120) {
        throw new Error(`${name} RSS grew ${before} -> ${after} kB over one stability window`);
      }
    }
    if (agent.exit.t !== null) {
      throw new Error("agent exited spontaneously during stability");
    }
    record.pass = true;
  } catch (error) {
    record.pass = false;
    record.fail = String(error?.message ?? error);
  } finally {
    if (agent) await agent.kill().catch(() => undefined);
    if (relay) await relay.close().catch(() => undefined);
    if (proxy) await proxy.close().catch(() => undefined);
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
        `slowOp=${record.slowOpMs ?? "-"}ms steady=${record.steadyCallsOk ?? "-"}/${record.steadyCallsTotal ?? "-"} ` +
        `r2aBytes=${record.relayToAgentBytes ?? "-"} rssRelay=${record.rssRelayBeforeKb ?? "-"}->${record.rssRelayAfterKb ?? "-"}kb ` +
        `rssAgent=${record.rssAgentBeforeKb ?? "-"}->${record.rssAgentAfterKb ?? "-"}kb`,
    );
  }
  const passed = records.filter((r) => r.pass).length;
  console.log(`row2-stability: ${passed}/${records.length} seeds passed`);
  process.exit(passed === records.length ? 0 : 1);
}

await main();
