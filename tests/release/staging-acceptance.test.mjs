import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const scriptPath = path.join(repoRoot, "scripts", "staging-acceptance.mjs");

function runHarness(args, extraEnv = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("staging harness --describe outputs canonical G1-G7 and M1-M10 contract", () => {
  const res = runHarness(["--describe"]);
  assert.equal(res.status, 0, `expected exit 0, stderr=${res.stderr}`);
  const plan = JSON.parse(res.stdout);
  assert.equal(plan.runbook, "docs/release/windows-staging-acceptance.md");
  assert.deepEqual(
    plan.forbiddenHosts,
    ["LENO", "CUCK", "SURFACE", "RTX", "VAULTER"],
  );
  assert.deepEqual(
    plan.gates.map((g) => g.id),
    ["G1", "G2", "G3", "G4", "G5", "G6", "G7"],
  );
  assert.deepEqual(
    plan.mobileChecks.map((m) => m.id),
    ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10"],
  );
  assert.equal(typeof plan.environment.platform, "string");
  assert.equal(typeof plan.environment.interactiveDesktopAvailable, "boolean");
  assert.equal(typeof plan.environment.physicalMobileAvailable, "boolean");
});

test("staging harness fails closed on every forbidden production hostname without creating staging files", () => {
  const tmpIsolated = mkdtempSync(path.join(os.tmpdir(), "tp-staging-guard-"));
  try {
    for (const host of ["Leno", "LENO", "cuck", "Surface", "RTX", "VaUlTeR"]) {
      const res = runHarness(["--hostname", host, "--allow-partial"], {
        TMPDIR: tmpIsolated,
        TEMP: tmpIsolated,
        TMP: tmpIsolated,
      });
      assert.notEqual(res.status, 0, `forbidden host ${host} must fail closed`);
      assert.match(res.stderr + res.stdout, /ABORTED/i);
      assert.equal(
        readdirSync(tmpIsolated).length,
        0,
        `must not create staging dirs for forbidden host ${host}`,
      );
    }
  } finally {
    rmSync(tmpIsolated, { recursive: true, force: true });
  }
});

test("staging harness rejects invalid CLI flags and unsafe mode combinations", () => {
  const badFlag = runHarness(["--unknown-flag"]);
  assert.equal(badFlag.status, 2);

  const badMode = runHarness(["--mode", "invalid"]);
  assert.equal(badMode.status, 2);

  const badPause = runHarness(["--mode", "auto", "--pause-for-mobile"]);
  assert.equal(badPause.status, 2);

  const certWithoutKey = runHarness(["--tls-cert", "/tmp/cert.pem"]);
  assert.equal(certWithoutKey.status, 2);

  const keyWithoutCert = runHarness(["--tls-key", "/tmp/key.pem"]);
  assert.equal(keyWithoutCert.status, 2);

  const badPublicOriginHttp = runHarness(["--public-origin", "http://staging.example.com"]);
  assert.equal(badPublicOriginHttp.status, 2);

  const badPublicOriginPath = runHarness(["--public-origin", "https://staging.example.com/portal"]);
  assert.equal(badPublicOriginPath.status, 2);

  const certWithWinTrust = runHarness([
    "--tls-cert",
    "/tmp/cert.pem",
    "--tls-key",
    "/tmp/key.pem",
    "--trust-win-cert",
  ]);
  assert.equal(certWithWinTrust.status, 2);
});

test("staging harness helper enforces partial vs full gate outcome rules", async () => {
  const mod = await import(pathToFileURL(scriptPath).href);
  assert.equal(
    typeof mod.evaluateOverallOutcome,
    "function",
    "staging-acceptance.mjs must export evaluateOverallOutcome",
  );
  assert.equal(
    typeof mod.assertAllowedHostname,
    "function",
    "staging-acceptance.mjs must export assertAllowedHostname",
  );
  assert.equal(
    typeof mod.buildRelayAuthConfig,
    "function",
    "staging-acceptance.mjs must export buildRelayAuthConfig",
  );

  // Positive hostnames pass
  assert.doesNotThrow(() => mod.assertAllowedHostname("WIN-STAGING-01"));
  for (const h of mod.FORBIDDEN_HOSTS) {
    assert.throws(() => mod.assertAllowedHostname(h.toLowerCase()), /ABORTED/);
  }

  // Auth config uses token_env indirection, never raw secret tokens
  const authCfg = mod.buildRelayAuthConfig();
  const serialized = JSON.stringify(authCfg);
  assert.match(serialized, /STAGING_OWNER_TOKEN/);
  assert.match(serialized, /STAGING_OPERATOR_TOKEN/);
  assert.match(serialized, /STAGING_UNPAIRED_TOKEN/);
  assert.doesNotMatch(serialized, /"token"\s*:/);

  const partialGates = {
    G1: { status: "PASS" },
    G2: { status: "PASS" },
    G3: { status: "PASS" },
    G4: { status: "BLOCKED" },
    G5: { status: "PASS" },
    G6: { status: "BLOCKED" },
    G7: { status: "PASS" },
  };
  assert.equal(
    mod.evaluateOverallOutcome({ allowPartial: false, gates: partialGates }).ok,
    false,
    "full run must NOT pass when any gate is BLOCKED",
  );
  assert.equal(
    mod.evaluateOverallOutcome({ allowPartial: true, gates: partialGates }).ok,
    true,
    "partial rehearsal passes only when runnable gates PASS and missing env gates are BLOCKED",
  );

  const failingPartial = {
    ...partialGates,
    G3: { status: "FAIL" },
  };
  assert.equal(
    mod.evaluateOverallOutcome({ allowPartial: true, gates: failingPartial }).ok,
    false,
    "partial rehearsal MUST fail if any gate records FAIL",
  );

  const allPass = {
    G1: { status: "PASS" },
    G2: { status: "PASS" },
    G3: { status: "PASS" },
    G4: { status: "PASS" },
    G5: { status: "PASS" },
    G6: { status: "PASS" },
    G7: { status: "PASS" },
  };
  assert.equal(
    mod.evaluateOverallOutcome({ allowPartial: false, gates: allPass }).ok,
    true,
  );
});

test("staging harness supports trusted HTTPS modes for G6 without requiring disposable root CA on phones", async () => {
  const mod = await import(pathToFileURL(scriptPath).href);
  assert.equal(typeof mod.buildStagingSanEntries, "function");
  assert.equal(typeof mod.resolveRelayTlsTopology, "function");
  assert.equal(typeof mod.formatMobileCheckpointNote, "function");

  assert.deepEqual(mod.buildStagingSanEntries("100.64.0.12"), [
    "IP:127.0.0.1",
    "DNS:localhost",
    "IP:100.64.0.12",
  ]);
  assert.deepEqual(mod.buildStagingSanEntries("win-staging.tailnet.ts.net"), [
    "IP:127.0.0.1",
    "DNS:localhost",
    "DNS:win-staging.tailnet.ts.net",
  ]);

  const directTrusted = mod.resolveRelayTlsTopology(
    {
      tlsCert: "/tls/staging.crt",
      tlsKey: "/tls/staging.key",
      lanHost: "win-staging.tailnet.ts.net",
      publicOrigin: null,
      trustProxyHeaders: false,
    },
    18788,
  );
  assert.equal(directTrusted.mode, "direct-trusted-tls");
  assert.equal(directTrusted.bindHost, "0.0.0.0");
  assert.equal(directTrusted.publicHttpBase, "https://win-staging.tailnet.ts.net:18788");
  assert.equal(directTrusted.relayWsBase, "wss://win-staging.tailnet.ts.net:18788");
  assert.equal(directTrusted.tetherdNeedsCaCert, false);
  assert.equal(directTrusted.browserNeedsSpkiPin, false);
  assert.equal(directTrusted.requiresOpenssl, false);

  const directTrustedIp = mod.resolveRelayTlsTopology(
    {
      tlsCert: "/tls/staging.crt",
      tlsKey: "/tls/staging.key",
      lanHost: "100.64.0.12",
      publicOrigin: null,
      trustProxyHeaders: false,
    },
    18788,
  );
  assert.equal(directTrustedIp.bindHost, "100.64.0.12");
  assert.equal(directTrustedIp.publicHttpBase, "https://100.64.0.12:18788");

  const reverseProxy = mod.resolveRelayTlsTopology(
    {
      tlsCert: null,
      tlsKey: null,
      lanHost: null,
      publicOrigin: "https://win-staging.tailnet.ts.net",
      trustProxyHeaders: true,
    },
    18788,
  );
  assert.equal(reverseProxy.mode, "trusted-reverse-proxy");
  assert.equal(reverseProxy.bindHost, "127.0.0.1");
  assert.equal(reverseProxy.publicHttpBase, "https://win-staging.tailnet.ts.net");
  assert.equal(reverseProxy.localHealthBase, "http://127.0.0.1:18788");
  assert.equal(reverseProxy.relayWsBase, "ws://127.0.0.1:18788");
  assert.equal(reverseProxy.tetherdAllowInsecureLocalhost, true);
  assert.equal(reverseProxy.tetherdNeedsCaCert, false);
  assert.equal(reverseProxy.browserNeedsSpkiPin, false);
  assert.equal(reverseProxy.requireExactRelayPort, true);
  assert.equal(reverseProxy.requiresOpenssl, false);

  const proxyNote = mod.formatMobileCheckpointNote({
    topology: reverseProxy,
    ownerTokenFile: "/tmp/secrets/owner.token",
    ephemeralCaCrt: null,
  });
  assert.match(proxyNote, /Portal URL: https:\/\/win-staging\.tailnet\.ts\.net\/portal/);
  assert.doesNotMatch(proxyNote, /CA file:/);
  assert.match(proxyNote, /No disposable root CA installation required/i);

  const ephemeral = mod.resolveRelayTlsTopology(
    {
      tlsCert: null,
      tlsKey: null,
      lanHost: null,
      publicOrigin: null,
      trustProxyHeaders: false,
    },
    18788,
  );
  assert.equal(ephemeral.mode, "ephemeral-ca");
  assert.equal(ephemeral.requiresOpenssl, true);
  assert.equal(ephemeral.tetherdNeedsCaCert, true);
  const ephemeralNote = mod.formatMobileCheckpointNote({
    topology: ephemeral,
    ownerTokenFile: "/tmp/secrets/owner.token",
    ephemeralCaCrt: "/tmp/tls/relay-ca.crt",
  });
  assert.match(ephemeralNote, /CA file: \/tmp\/tls\/relay-ca\.crt/);
});

test("staging harness --preflight-only rejects strict exit on non-interactive Linux unless --allow-partial is set", () => {
  if (process.platform === "win32" && !process.env.GITHUB_ACTIONS) {
    return;
  }
  const strictRes = runHarness(["--preflight-only", "--hostname", "cloud-staging-test"]);
  assert.notEqual(
    strictRes.status,
    0,
    "without --allow-partial on non-Windows-interactive host, preflight must not claim pass",
  );
  const partialRes = runHarness([
    "--preflight-only",
    "--hostname",
    "cloud-staging-test",
    "--allow-partial",
  ]);
  assert.equal(
    partialRes.status,
    0,
    `expected --preflight-only --allow-partial to pass cleanly, stderr=${partialRes.stderr}`,
  );
});


test("missing, pending, unknown and mandatory blocked gates cannot pass", async () => {
  const { evaluateOverallOutcome } = await import(pathToFileURL(scriptPath).href);
  const valid = Object.fromEntries(["G1","G2","G3","G4","G5","G6","G7"].map(id => [id, {status:"PASS"}]));
  assert.equal(evaluateOverallOutcome({allowPartial:true,gates:{}}).ok,false);
  for (const id of Object.keys(valid)) {
    const missing = {...valid}; delete missing[id];
    assert.equal(evaluateOverallOutcome({allowPartial:true,gates:missing}).ok,false);
    for (const status of ["PENDING","UNKNOWN",null]) {
      assert.equal(evaluateOverallOutcome({allowPartial:true,gates:{...valid,[id]:{status}}}).ok,false);
    }
    if (!["G4","G6"].includes(id)) {
      assert.equal(evaluateOverallOutcome({allowPartial:true,gates:{...valid,[id]:{status:"BLOCKED"}}}).ok,false);
    }
  }
});

test("preflight cannot be represented as completed staging acceptance", () => {
  const res = runHarness(["--preflight-only","--allow-partial","--hostname","cloud-staging-test"]);
  assert.equal(res.status,0);
  const report=JSON.parse(res.stdout);
  assert.equal(report.execution,"preflight_only");
  assert.equal(report.acceptance_verified,false);
  assert.match(report.outcome.summary,/PREFLIGHT ONLY/);
});
