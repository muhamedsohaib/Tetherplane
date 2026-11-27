// Row-2 blackhole integration oracle (S6).
// Real tetherd (child) + real relay (in-process) behind a scriptable TCP
// proxy. Fault: proxy drops both directions with TCP held open.
// Measures relay retire, agent detect, restore-after-heal, request
// recovery, and resource deltas. One JSON record per seed on --append.
// Usage: node row2-blackhole.mjs [--seeds N] [--seed-offset K]
//   [--tetherd-bin PATH] [--heartbeat intervalMs,staleMs|production]
//   [--append FILE] [--seed-timeout-ms MS]
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
    seeds: 1,
    seedOffset: 0,
    tetherdBin: DEFAULT_TETHERD_BIN,
    heartbeat: "25,100",
    append: null,
    seedTimeoutMs: 150_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--seeds") args.seeds = Number(value);
    else if (flag === "--seed-offset") args.seedOffset = Number(value);
    else if (flag === "--tetherd-bin") args.tetherdBin = value;
    else if (flag === "--heartbeat") args.heartbeat = value;
    else if (flag === "--append") args.append = value;
    else if (flag === "--seed-timeout-ms") args.seedTimeoutMs = Number(value);
    else continue;
    i += 1;
  }
  return args;
}

async function runSeed(seed, options) {
  const production = options.heartbeat === "production";
  const heartbeat = production
    ? undefined
    : (() => {
        const [intervalMs, staleMs] = options.heartbeat.split(",").map(Number);
        return { intervalMs, staleMs };
      })();
  const caps = production
    ? { retireMs: 70_000, suspectMs: 25_000, detectMs: 30_000, restoreMs: 30_000 }
    : { retireMs: 10_000, suspectMs: 30_000, detectMs: 30_000, restoreMs: 30_000 };
  const deviceId = "lab-device";
  const accountId = "account-a";
  const secret = `lab-fault-credential-seed-${seed}-x`;
  const record = {
    oracle: "row2-blackhole",
    seed,
    mode: production ? "production" : "scaled",
    pass: false,
  };
  let relay = null;
  let proxy = null;
  let agent = null;
  let faultAt = null;
  let settlements = 0;
  let victimResult = null;
  try {
    relay = await pairedRelay({
      secret,
      deviceId,
      accountId,
      heartbeat,
      routeTimeoutMs: 60_000,
    });
    proxy = await startProxy(relay.port);
    agent = spawnAgent({
      bin: options.tetherdBin,
      proxyPort: proxy.port,
      deviceId,
      credential: secret,
    });

    // Healthy phase: path proven live before the fault (anti-vacuity).
    await until(() => relay.router.isOnline(deviceId), {
      timeoutMs: 15_000,
      what: "agent online",
    });
    // request_ids are real UUIDs: the agent's envelope types them as
    // Uuid, and anything else is a relay protocol violation.
    const healthyId = randomUUID();
    const healthy = await relay.router.call(
      labIdentity(accountId),
      labInvocation(deviceId, healthyId),
    );
    if (healthy.status !== "success" || healthy.request_id !== healthyId) {
      throw new Error(`pre-fault call failed: ${JSON.stringify(healthy)}`);
    }
    record.rssRelayBeforeKb = relayRssKb();
    record.rssAgentBeforeKb = await agentRssKb(agent.pid);

    // Victim: genuinely in flight when the fault lands (5 s op).
    const victimId = randomUUID();
    const victim = relay.router
      .call(
        labIdentity(accountId),
        labInvocation(deviceId, victimId, "process.run", {
          program: "sleep",
          args: ["5"],
          wait_ms: 6_000,
        }),
      )
      .then((result) => {
        settlements += 1;
        victimResult = result;
        return result;
      });
    void victim.catch(() => undefined);
    await sleep(1_000);
    if (settlements !== 0) {
      throw new Error("victim settled before the fault; run is vacuous");
    }

    // Fault: half-open blackhole, both directions, TCP held open.
    const dialsBefore = proxy.stats.connections;
    faultAt = Date.now();
    proxy.setBlackhole(true);

    await until(() => !relay.router.isOnline(deviceId), {
      timeoutMs: caps.retireMs,
      what: production ? "presence cleared" : "relay retire",
    });
    record.retireMs = Date.now() - faultAt;
    // Race resolution, by design: with a scaled relay the 100 ms stale
    // timer wins; at production scale the agent's 20 s detector wins
    // and the relay cleans up via close (its own 45 s timer is proven
    // separately by row2-production-retire).
    record.retireKind = production ? "agent-close-first" : "relay-stale-timer";
    if (production && record.retireMs > 40_000) {
      throw new Error(`agent should win the race at production scale, presence cleared at ${record.retireMs} ms`);
    }

    await until(() => settlements > 0, {
      timeoutMs: caps.retireMs + 5_000,
      what: "victim settlement",
    });
    record.victimSettlements = settlements;
    record.victimCode = victimResult?.error?.code ?? null;
    record.victimRequestId = victimResult?.request_id ?? null;
    if (record.victimCode !== "disconnected" || record.victimRequestId !== victimId) {
      throw new Error(`victim must settle disconnected with its own id, saw ${JSON.stringify(victimResult)}`);
    }

    // Suspect is only observable when one socket survives 15 s silent,
    // i.e. production relay timing (the anchor). With a scaled relay the
    // sockets die fast, so waiting would block the seed on a line that
    // correctly never comes; take it from the buffer instead.
    let suspect = agent.lines.find((entry) => entry.line.includes("heartbeat suspect")) ?? null;
    if (production && !suspect) {
      suspect = await agent
        .waitForLine((line) => line.includes("heartbeat suspect"), caps.suspectMs, "agent suspect")
        .catch(() => null);
    }
    record.suspectMs = suspect ? suspect.t - faultAt : null;

    const detect = await agent.waitForLine(
      (line) => line.includes("relay connection lost"),
      caps.detectMs,
      "agent detect",
    );
    record.detectMs = detect.t - faultAt;
    record.detectLine = detect.line.slice(0, 200);
    record.detectKind = detect.line.includes("heartbeat timeout")
      ? "heartbeat"
      : detect.line.includes("handshake timed out")
        ? "dial-timeout"
        : "transport";
    // Scaled relay terminates at ~staleMs, so the agent learns first via
    // the resulting transport error; at production scale the agent's own
    // heartbeat detector (20 s) fires before the relay retires (45 s).
    // Both paths are real detection; label and assert the expected one.
    const expectedKind = production ? "heartbeat" : "transport";
    if (record.detectKind !== expectedKind) {
      throw new Error(`expected ${expectedKind} detection, saw ${record.detectKind}: ${record.detectLine}`);
    }

    // Engagement proof: relay pings were swallowed by the hole (the
    // direct cause of the retire). Agent->relay bytes are recorded but
    // not asserted here — a quiet agent has nothing to send in 130 ms.
    record.droppedRelayToAgent = proxy.stats.relayToAgentDropped;
    if (record.droppedRelayToAgent <= 0) {
      throw new Error("fault never engaged; relay pings were not swallowed");
    }

    // Heal: restore is measured honestly from connectivity return.
    // Scaled seeds spread the heal over 0-20 s (deterministic in the
    // seed) to sample every redial phase; the anchor heals 1 s after
    // both sides have observed the fault at production scale.
    record.healDelayMs = production ? 1_000 : (seed * 7919) % 20_000;
    record.healRule = production ? "retire+detect+1s" : "detect+spread";
    await sleep(record.healDelayMs);
    const healAt = Date.now();
    proxy.setBlackhole(false);
    await until(() => relay.router.isOnline(deviceId), {
      timeoutMs: caps.restoreMs,
      what: "reconnect within 30 s of heal",
    });
    record.restoreMs = Date.now() - healAt;
    if (record.restoreMs > 30_000) {
      throw new Error(`restore took ${record.restoreMs} ms, bound is 30000`);
    }

    const freshId = randomUUID();
    const fresh = await relay.router.call(
      labIdentity(accountId),
      labInvocation(deviceId, freshId),
    );
    record.freshOk = fresh.status === "success" && fresh.request_id === freshId;
    if (!record.freshOk) {
      throw new Error(`post-heal call failed: ${JSON.stringify(fresh)}`);
    }
    if (settlements !== 1) {
      throw new Error(`victim settled ${settlements} times, expected exactly once`);
    }

    // Recovery proof: the agent dialed again after the fault (restore
    // itself required it); final dropped counters show the whole hole.
    record.recoveryDials = proxy.stats.connections - dialsBefore;
    if (record.recoveryDials < 1) {
      throw new Error("agent never attempted recovery after the fault");
    }
    record.droppedAgentToRelay = proxy.stats.agentToRelayDropped;
    record.dialTimesMs = proxy.stats.connectionTimes.map((t) => t - faultAt);
    record.agentLines = agent.lines.map((entry) => ({
      tMs: entry.t - faultAt,
      stream: entry.stream,
      line: entry.line.slice(0, 200),
    }));
    record.rssRelayAfterKb = relayRssKb();
    record.rssAgentAfterKb = await agentRssKb(agent.pid);
    if (agent.exit.t !== null) {
      throw new Error(`agent exited spontaneously: code=${agent.exit.code} signal=${agent.exit.signal}`);
    }
    record.pass = true;
  } catch (error) {
    record.pass = false;
    record.fail = String(error?.message ?? error);
    // Failure forensics: what the agent said and when it dialed, even
    // when the seed died before the heal phase.
    if (faultAt !== null) {
      if (agent) {
        record.agentLines = agent.lines.map((entry) => ({
          tMs: entry.t - faultAt,
          stream: entry.stream,
          line: entry.line.slice(0, 200),
        }));
      }
      if (proxy) {
        record.dialTimesMs = proxy.stats.connectionTimes.map((t) => t - faultAt);
      }
      record.victimSettlementsAtFail = settlements;
      record.victimAtFail = victimResult
        ? { code: victimResult.error?.code ?? null, request_id: victimResult.request_id ?? null }
        : null;
    }
  } finally {
    if (agent) await agent.kill().catch(() => undefined);
    if (relay) await relay.close().catch(() => undefined);
    if (proxy) await proxy.close().catch(() => undefined);
  }
  return record;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { n: values.length, mean: Math.round(mean), p50: pick(0.5), p99: pick(0.99), max: sorted[sorted.length - 1] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const records = [];
  for (let i = 0; i < options.seeds; i++) {
    const seed = options.seedOffset + i;
    const record = await Promise.race([
      runSeed(seed, options),
      sleep(options.seedTimeoutMs).then(() => ({
        oracle: "row2-blackhole",
        seed,
        mode: options.heartbeat === "production" ? "production" : "scaled",
        pass: false,
        fail: `seed exceeded ${options.seedTimeoutMs} ms cap`,
      })),
    ]);
    // Backstop only: every phase inside runSeed is already bounded by
    // until(), so seeds terminate and clean up on their own; the race
    // fires solely if a phase hangs past its own caps.
    records.push(record);
    if (options.append) appendFileSync(options.append, `${JSON.stringify(record)}\n`);
    console.log(
      `seed=${seed} ${record.pass ? "PASS" : "FAIL"} ` +
        `retire=${record.retireMs ?? "-"}ms detect=${record.detectMs ?? "-"}ms(${record.detectKind ?? "-"}) ` +
        `healDelay=${record.healDelayMs ?? "-"}ms restore=${record.restoreMs ?? "-"}ms suspect=${record.suspectMs ?? "-"}ms` +
        (record.pass ? "" : ` fail=${record.fail ?? "unknown"}`),
    );
  }
  const passed = records.filter((r) => r.pass);
  if (passed.length > 0) {
    for (const key of ["retireMs", "detectMs", "restoreMs"]) {
      const values = passed.map((r) => r[key]).filter((v) => typeof v === "number");
      if (values.length > 0) console.log(`${key}: ${JSON.stringify(stats(values))}`);
    }
  }
  console.log(`row2-blackhole: ${passed.length}/${records.length} seeds passed`);
  process.exit(passed.length === records.length ? 0 : 1);
}

await main();
