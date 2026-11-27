// Row-2 production-retire oracle (S6): a silent raw peer against the
// REAL relay at PRODUCTION heartbeat scale (15 s / 45 s) must be
// retired with 45 s <= t <= 60 s, and its in-flight call must settle
// disconnected with its own request_id. Single run (~50 s).
// Usage: node row2-production-retire.mjs [--append FILE]
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import {
  labIdentity,
  labInvocation,
  pairedRelay,
  rawUpgrade,
  sleep,
  until,
} from "./harness.mjs";

function parseArgs(argv) {
  const args = { append: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--append") {
      args.append = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const record = { oracle: "row2-production-retire", seed: 0, mode: "production", pass: false };
  let relay = null;
  let raw = null;
  try {
    const deviceId = "lab-device";
    const accountId = "account-a";
    const secret = "lab-production-retire-0123456789";
    relay = await pairedRelay({
      secret,
      deviceId,
      accountId,
      heartbeat: undefined,
      routeTimeoutMs: 120_000,
    });
    raw = await rawUpgrade(relay.port, {
      authorization: `Device ${secret}`,
      "x-tetherplane-device-id": deviceId,
    });
    await until(() => relay.router.isOnline(deviceId), {
      timeoutMs: 15_000,
      what: "peer online",
    });
    const acceptAt = Date.now();
    const victimId = randomUUID();
    let settlements = 0;
    let victimResult = null;
    const victim = relay.router
      .call(labIdentity(accountId), labInvocation(deviceId, victimId))
      .then((result) => {
        settlements += 1;
        victimResult = result;
        return result;
      });
    void victim.catch(() => undefined);
    await sleep(100);
    if (settlements !== 0) {
      throw new Error("victim settled before the silence window; run is vacuous");
    }
    // Fault: the peer goes silent from here (never answers nonces).
    // The stale deadline runs from accept; measure the retire age from
    // there so pre-fault setup cannot shift the bound.
    const retireStarted = Date.now();
    await Promise.all([
      (async () => {
        await until(() => !relay.router.isOnline(deviceId), {
          timeoutMs: 70_000,
          what: "production retire",
        });
      })(),
      raw.closed(),
    ]);
    record.retireMs = Date.now() - retireStarted;
    record.retireAgeMs = Date.now() - acceptAt;
    // Normative S2 bound at production scale: no earlier than the
    // 45 s stale deadline (no false trip), never past 60 s.
    if (record.retireAgeMs < 44_500 || record.retireAgeMs > 60_000) {
      throw new Error(`production retire age ${record.retireAgeMs} ms violates [44500, 60000]`);
    }
    await until(() => settlements > 0, { timeoutMs: 5_000, what: "victim settlement" });
    record.victimSettlements = settlements;
    record.victimCode = victimResult?.error?.code ?? null;
    record.victimRequestId = victimResult?.request_id ?? null;
    if (settlements !== 1 || record.victimCode !== "disconnected" || record.victimRequestId !== victimId) {
      throw new Error(`victim must settle once as disconnected, saw ${JSON.stringify(victimResult)}`);
    }
    record.pass = true;
  } catch (error) {
    record.pass = false;
    record.fail = String(error?.message ?? error);
  } finally {
    if (raw) raw.close();
    if (relay) await relay.close().catch(() => undefined);
  }
  if (options.append) appendFileSync(options.append, `${JSON.stringify(record)}\n`);
  console.log(
    `production-retire ${record.pass ? "PASS" : "FAIL"} ` +
      `retire=${record.retireMs ?? "-"}ms victim=${record.victimCode ?? "-"}` +
      (record.pass ? "" : ` fail=${record.fail ?? "unknown"}`),
  );
  process.exit(record.pass ? 0 : 1);
}

await main();
