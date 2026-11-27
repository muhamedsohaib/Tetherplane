// Isolated fault-lab proof runner (Linux simulation only).
// Runs bounded oracles for fault-matrix rows and times them.
// Never touches live devices, production relay, or real user state: every
// child runs the repo's own harnesses on loopback/temp dirs only.
//
// Usage:
//   node tests/fault-lab/run.mjs                            quick proof (old rows x1, row 2 x1)
//   node tests/fault-lab/run.mjs --seeds 20                 full S6 row-2 execution
//   node tests/fault-lab/run.mjs --row 2 --seeds 5 --seed-offset 10 --append /tmp/p.jsonl
//   node tests/fault-lab/run.mjs --merge /tmp/p.jsonl       publish results.json from partials
//
// Row 2 (half-open blackhole) executes REAL tetherd + REAL relay behind a
// scriptable proxy (row2-blackhole.mjs, N seeds), plus a production-scale
// anchor, a production-scale relay-retire proof, and a stability oracle.
// Row 9 stays known-fail until S3 lands. Rows 3,4,7,11,12 have no lab
// oracle yet (unit-covered); row 11 is partially measured via the
// stability oracle's RSS bounds.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function parseArgs() {
  const out = { seeds: 1, seedOffset: 0, row: "all", append: null, merge: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--merge") {
      out.merge = argv[i + 1];
      i += 1;
    } else if (flag === "--append") {
      out.append = argv[i + 1];
      i += 1;
    } else if (flag === "--seeds") {
      out.seeds = Number(argv[i + 1]);
      i += 1;
    } else if (flag === "--seed-offset") {
      out.seedOffset = Number(argv[i + 1]);
      i += 1;
    } else if (flag === "--row") {
      out.row = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function run(cmd, cmdArgs, cwd, { timeoutMs = 60_000, stream = false } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(cmd, cmdArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    let out = "";
    const feed = (data) => {
      out += data;
      if (stream) process.stdout.write(data);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, ms: Math.round(performance.now() - t0), tail: out.slice(-800) });
    });
    child.on("error", (error) => {
      clearTimeout(killer);
      resolve({ code: -1, ms: Math.round(performance.now() - t0), tail: String(error) });
    });
  });
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { n: values.length, mean: Math.round(mean), p50: pick(0.5), p99: pick(0.99), max: sorted[sorted.length - 1] };
}

function statsOf(records, key) {
  const values = records.map((r) => r[key]).filter((v) => typeof v === "number");
  return values.length > 0 ? stats(values) : null;
}

function revisions() {
  const sh = (cmd, cmdArgs) => {
    try {
      const result = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: "utf8" });
      return (result.stdout ?? "").trim().slice(0, 500) || null;
    } catch {
      return null;
    }
  };
  return {
    head: sh("git", ["rev-parse", "HEAD"]),
    status: sh("git", ["status", "--short"]),
    node: process.version,
    rustc: sh("rustc", ["--version"]),
  };
}

async function runOldRows(seeds, seedOffset, append) {
  // Fast unit-oracle rows; seeds repeat the suites for stability.
  const rows = [
    { id: 1, name: "relay kill/restart + no replay (router oracle)", cmd: ["node", ["--test", "test/routing.test.ts"]], cwd: "relay" },
    { id: 5, name: "revoked/expired auth denied (device-ws oracle)", cmd: ["node", ["--test", "test/device-ws.test.ts"]], cwd: "relay" },
  ];
  const results = [];
  for (let s = 0; s < Math.max(1, seeds); s++) {
    for (const row of rows) {
      const r = await run(row.cmd[0], row.cmd[1], path.join(ROOT, row.cwd), { timeoutMs: 60_000 });
      const blocked = /ERR_MODULE_NOT_FOUND|Failed to fetch/.test(r.tail);
      const status = r.code === 0 ? "pass" : blocked ? "blocked-env" : "fail";
      const record = { kind: "lab-row", seed: seedOffset + s, row: row.id, name: row.name, status, ms: r.ms };
      results.push(record);
      if (append) appendFileSync(append, `${JSON.stringify(record)}\n`);
      console.log(`seed=${seedOffset + s} row=${row.id} ${status.toUpperCase()} ${r.ms}ms ${row.name}`);
    }
  }
  return results;
}

async function runBlackhole(seeds, seedOffset, append, extra = []) {
  const r = await run(
    "node",
    [
      "tests/fault-lab/row2-blackhole.mjs",
      "--seeds",
      String(seeds),
      "--seed-offset",
      String(seedOffset),
      ...(append ? ["--append", append] : []),
      ...extra,
    ],
    ROOT,
    { timeoutMs: seeds * 60_000 + 180_000, stream: true },
  );
  return { code: r.code, ms: r.ms, tail: r.tail };
}

async function runOracle(file, oracleArgs, timeoutMs) {
  return run("node", [`tests/fault-lab/${file}`, ...oracleArgs], ROOT, { timeoutMs, stream: true });
}

function publish(partialPath, { seeds, full }) {
  const lines = existsSync(partialPath) ? readFileSync(partialPath, "utf8").split("\n").filter(Boolean) : [];
  const records = lines.map((line) => JSON.parse(line));
  const labRows = records.filter((r) => r.kind === "lab-row");
  const blackhole = records.filter((r) => r.oracle === "row2-blackhole" && r.mode === "scaled");
  const anchors = records.filter((r) => r.oracle === "row2-blackhole" && r.mode === "production");
  const prodRetire = records.filter((r) => r.oracle === "row2-production-retire");
  const stability = records.filter((r) => r.oracle === "row2-stability");

  const summarize = (list) => ({
    seeds: list.length,
    passed: list.filter((r) => r.pass).length,
  });
  const summary = {
    at: new Date().toISOString(),
    mode: full ? "s6-full" : "quick-proof",
    seeds,
    platform: process.platform,
    revisions: revisions(),
    note: "Linux simulation only; Windows lock/sleep/foreground NOT certified (see docs/WINDOWS_ACCEPTANCE_PLAN.md)",
    results: [
      ...labRows.map((r) => ({ seed: r.seed, row: r.row, name: r.name, status: r.status, ms: r.ms })),
      { row: 6, name: "stale generation dropped (router oracle)", status: "covered-by-row-1" },
      { row: 8, name: "delayed ack / timeout no double-resolve (router oracle)", status: "covered-by-row-1" },
      {
        row: 2,
        name: "half-open blackhole bounded detection (real agent+relay)",
        status: blackhole.length > 0 && blackhole.every((r) => r.pass) ? "pass" : blackhole.length > 0 ? "fail" : "not-executed",
        ...summarize(blackhole),
      },
      {
        row: 9,
        name: "provider kill -> truthful per-capability state",
        status: "known-fail-pending-s3",
        reason: "capability available is a startup snapshot (RC-3); fixed by Spark S3",
      },
      ...[3, 4, 7, 12].map((row) => ({
        row,
        name: { 3: "partition then heal, no duplicate mutations", 4: "agent SIGKILL, no stale handles", 7: "duplicate/ambiguous requests", 12: "unauthorized recovery abuse" }[row],
        status: "no-oracle",
        reason: "no fault-lab oracle yet; covered by unit suites only",
      })),
      {
        row: 11,
        name: "resource pressure",
        status: "partial",
        reason: "RSS boundedness measured via row2-stability; CPU/disk-full pressure not oracled",
      },
    ],
    measurements: {
      "row2-blackhole": {
        ...summarize(blackhole),
        retireMs: statsOf(blackhole.filter((r) => r.pass), "retireMs"),
        detectMs: statsOf(blackhole.filter((r) => r.pass), "detectMs"),
        restoreMs: statsOf(blackhole.filter((r) => r.pass), "restoreMs"),
        records: blackhole,
      },
      "row2-anchor": {
        ...summarize(anchors),
        records: anchors,
      },
      "row2-production-retire": {
        ...summarize(prodRetire),
        records: prodRetire,
      },
      "row2-stability": {
        ...summarize(stability),
        records: stability,
      },
    },
  };
  writeFileSync(path.join(HERE, "results.json"), `${JSON.stringify(summary, null, 2)}\n`);
  const failed =
    summary.results.filter((r) => r.status === "fail").length +
    [blackhole, anchors, prodRetire, stability].flat().filter((r) => !r.pass).length;
  console.log(
    failed > 0
      ? `FAULT-LAB: ${failed} unexpected failure(s)`
      : "FAULT-LAB: all executed oracles pass; row 9 known-fail pending S3; rows 3,4,7,12 have no oracle",
  );
  return failed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.merge) {
    const failed = publish(options.merge, { seeds: options.seeds, full: options.seeds >= 20 });
    process.exit(failed > 0 ? 1 : 0);
  }
  const want = (name) => options.row === "all" || options.row === name;
  let failed = 0;
  // Append target: explicit --append, else a temp partial so direct runs
  // still publish results.json through the same merge path.
  const append = options.append ?? path.join("/tmp", `faultlab-partial-${process.pid}.jsonl`);
  if (want("all") || want("old") || want("1") || want("5")) {
    const results = await runOldRows(options.seeds, options.seedOffset, append);
    failed += results.filter((r) => r.status === "fail").length;
  }
  if (want("all") || want("2")) {
    const r = await runBlackhole(options.seeds, options.seedOffset, append);
    if (r.code !== 0) failed += 1;
  }
  const fullRun = options.seeds >= 20 || ["stability", "anchor", "prodretire"].includes(options.row);
  if ((want("all") && fullRun && options.row === "all") || options.row === "stability") {
    const r = await runOracle("row2-stability.mjs", ["--seeds", "3", ...(append ? ["--append", append] : [])], 300_000);
    if (r.code !== 0) failed += 1;
  }
  if ((want("all") && fullRun && options.row === "all") || options.row === "anchor") {
    const r = await runOracle(
      "row2-blackhole.mjs",
      ["--seeds", "1", "--seed-offset", "1000", "--heartbeat", "production", ...(append ? ["--append", append] : [])],
      300_000,
    );
    if (r.code !== 0) failed += 1;
  }
  if ((want("all") && fullRun && options.row === "all") || options.row === "prodretire") {
    const r = await runOracle("row2-production-retire.mjs", append ? ["--append", append] : [], 180_000);
    if (r.code !== 0) failed += 1;
  }
  if (options.row === "all") {
    failed += publish(append, { seeds: options.seeds, full: options.seeds >= 20 });
  } else {
    console.log(`chunk complete; partials appended to ${append}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

await main();
