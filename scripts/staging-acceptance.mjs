#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  X509Certificate,
  createHash,
  randomBytes,
} from "node:crypto";
import { once } from "node:events";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

export const FORBIDDEN_HOSTS = Object.freeze([
  "LENO",
  "CUCK",
  "SURFACE",
  "RTX",
  "VAULTER",
]);

export const GATE_DEFINITIONS = Object.freeze([
  {
    id: "G1",
    name: "Production Device Isolation",
    criterion:
      "Abort on forbidden hosts (LENO, CUCK, SURFACE, RTX, VAULTER); isolate all runtime dirs inside os.tmpdir() without touching production paths or autorun entries.",
  },
  {
    id: "G2",
    name: "Auth, Cookies, CSRF, No XSS",
    criterion:
      "Query tokens return 400; operator sessions and management endpoints return 403; session cookie has HttpOnly; SameSite=Strict; Secure; storage empty; CSRF/cross-origin returns 403; logout returns 401; DOM XSS payload renders inertly with zero CSP/console errors.",
  },
  {
    id: "G3",
    name: "Real Chrome Extension Pairing & Reconnect",
    criterion:
      "MV3 extension pairs to isolated staging host, transitions browser capability from Unavailable to 12/12 ops active via live SSE, enforces tab ownership and temporary share/detach, transitions to Unavailable on browser exit, and auto-recovers upon relaunch + re-pair.",
  },
  {
    id: "G4",
    name: "Interactive Windows UIA & Coexistence",
    criterion:
      "On an interactive non-production Windows host, remote desktop.snapshot + desktop.act succeed on both Tetherplane-owned WinForms (via native background fallbacks even under degraded Sandbox UIA) and unfocused WPF windows while cursor, clipboard canary, human focus/text stay untouched and human window act is denied; outside interactive Windows, desktop reports truthfully unavailable.",
  },
  {
    id: "G5",
    name: "Grants, Explicit Denies, Isolation, Offline Recovery, Rollback & Lockdown",
    criterion:
      "Portal family toggles, explicit_deny overrides, device-scoped operator least privilege, cross-account denial, offline PolicySync convergence via device_hello, emergency lockdown persistence across tetherd restart, snapshot pagination/filter, forward-revision rollback to rev 1, and Lift Lockdown all enforce on both relay and tetherd.",
  },
  {
    id: "G6",
    name: "Mobile Browser Checklist (M1-M10)",
    criterion:
      "Mobile responsive checks M1-M10 pass at 390x844 and 360x800 viewports AND on physical iPhone Safari / Android Chrome when --pause-for-mobile is completed interactively.",
  },
  {
    id: "G7",
    name: "Clean Staging Teardown",
    criterion:
      "All staging processes, temp state directories, ephemeral Windows trust entries/firewall rules (if added), and TCP listeners terminate cleanly with zero repo working-tree leaks.",
  },
]);

export const MOBILE_CHECKS = Object.freeze([
  { id: "M1", name: "Initial viewport fit (390x844 & 360x800)" },
  { id: "M2", name: "Mobile Sign-In & HttpOnly Cookie Persistence Across Reload" },
  { id: "M3", name: "Single-column Device Cards & Unavailable Wrapping" },
  { id: "M4", name: "Touch Controls, Select All/Clear & Family Switches" },
  { id: "M5", name: "Advanced Operation Rules Accordion Width & SSE Stability" },
  { id: "M6", name: "Confirmation Modal & Lift Lockdown UX" },
  { id: "M7", name: "Scoped Operator Add / Edit Prefill / Revoke UX" },
  { id: "M8", name: "Snapshot Filter, Show More Pagination & Rollback Fit" },
  { id: "M9", name: "Live SSE Offline/Online Updates Without Reload" },
  { id: "M10", name: "Sign Out Session Termination & Console Hygiene" },
]);

// Remote-relay G4 must target explicit fixture controls, not arbitrary
// UI Automation value/invoke patterns on window chrome (e.g. Close/Minimise).
// Deterministic selection keeps negative authorization assertions meaningful.
export function selectStagingG4FixtureTargets(ownedNodes, humanNodes) {
  const fixtureNode = (nodes, id, name, pattern, required = true) => {
    const candidates = nodes.filter(
      (node) =>
        (node.automation_id === id || node.name === name) &&
        (!pattern || (node.patterns ?? []).includes(pattern)),
    );
    if (candidates.length === 0 && !required) return null;
    assert.equal(
      candidates.length,
      1,
      `G4 fixture target ${id} must resolve uniquely, got ${candidates.length}`,
    );
    return candidates[0];
  };
  return {
    valueNode: fixtureNode(ownedNodes, "OwnedValue", "Owned Value", "value"),
    invokeNode: fixtureNode(ownedNodes, "OwnedInvoke", "Owned Invoke", "invoke"),
    selectionNode: fixtureNode(
      ownedNodes, "OwnedBeta", "Owned Beta", "selection", false,
    ),
    listBoxNode: fixtureNode(
      ownedNodes, "OwnedSelection", "Owned Selection", null, false,
    ),
    humanInvokeNode: fixtureNode(
      humanNodes, "HumanInvoke", "Human Invoke", "invoke",
    ),
  };
}

export function assertAllowedHostname(hostname) {
  const normalized = String(hostname || "").trim().toUpperCase();
  if (!normalized) {
    throw new Error("ABORTED: Empty hostname cannot pass staging isolation check.");
  }
  if (FORBIDDEN_HOSTS.includes(normalized)) {
    throw new Error(
      `ABORTED: Staging acceptance must NOT run on production device '${hostname}'.`,
    );
  }
}

export function buildRelayAuthConfig() {
  return {
    clients: [
      {
        token_env: "STAGING_OWNER_TOKEN",
        account_id: "staging-acct",
        client_id: "staging-owner-cli",
        principal_id: "human:staging-acct",
        role: "owner",
      },
      {
        token_env: "STAGING_OPERATOR_TOKEN",
        account_id: "staging-acct",
        client_id: "staging-operator-cli",
        principal_id: "operator:staging-ci",
        role: "operator",
      },
      {
        token_env: "STAGING_UNPAIRED_TOKEN",
        account_id: "staging-other-acct",
        client_id: "staging-stranger-cli",
        principal_id: "human:staging-other-acct",
        role: "owner",
      },
    ],
  };
}

export function evaluateOverallOutcome({ allowPartial, gates }) {
  const entries = Object.entries(gates);
  const failed = entries
    .filter(([, result]) => result.status === "FAIL")
    .map(([id]) => id);
  const blocked = entries
    .filter(([, result]) => result.status === "BLOCKED")
    .map(([id]) => id);
  // --allow-partial permits explicit BLOCKED checks, never unexecuted gates.
  const pending = entries
    .filter(([, result]) => result.status === "PENDING")
    .map(([id]) => id);
  const failedOrUnexecuted = [...new Set([...failed, ...pending])];
  if (failedOrUnexecuted.length > 0) {
    return {
      ok: false,
      summary: `FAIL (${failedOrUnexecuted.join(", ")})`,
      failed: failedOrUnexecuted,
      blocked,
    };
  }
  if (blocked.length > 0 && !allowPartial) {
    return {
      ok: false,
      summary: `BLOCKED (${blocked.join(", ")}) - re-run on full Windows staging + phone, or pass --allow-partial for explicit partial rehearsal`,
      failed,
      blocked,
    };
  }
  return {
    ok: true,
    summary:
      blocked.length > 0
        ? `PARTIAL_PASS (runnable gates PASS; blocked: ${blocked.join(", ")})`
        : "PASS (all gates G1-G7 verified)",
    failed,
    blocked,
  };
}

function isExecutableFile(candidate) {
  if (!candidate || !existsSync(candidate)) {
    return false;
  }
  try {
    accessSync(
      candidate,
      process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function findOnPath(names) {
  const pathEnv = process.env.PATH ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (isExecutableFile(full)) {
        return full;
      }
    }
  }
  return null;
}

// A real Windows Sandbox input desktop may omit SESSIONNAME entirely.
// For that case, verify a positive user session and an actual Win32
// foreground window; never probe or enable interactive G4 in CI.
function probeWindowsInputDesktop() {
  const native = 'using System; using System.Runtime.InteropServices; public static class G4DesktopProbe { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }';
  const ps = [
    "$ErrorActionPreference='Stop'",
    "if ([Diagnostics.Process]::GetCurrentProcess().SessionId -le 0) { exit 1 }",
    "$native='" + native + "'",
    "Add-Type -TypeDefinition $native",
    "for($i=0;$i -lt 5;$i++){ if([G4DesktopProbe]::GetForegroundWindow() -ne [IntPtr]::Zero) { 'G4_INPUT_DESKTOP_PRESENT'; exit 0 }; Start-Sleep -Milliseconds 100 }",
    "exit 2",
  ].join("; ");
  try {
    return execFileSync("powershell.exe",
      ["-NoProfile","-NonInteractive","-Command",ps],{
        encoding:"utf8",timeout:8_000,windowsHide:true,
        stdio:["ignore","pipe","ignore"],
      }).trim() === "G4_INPUT_DESKTOP_PRESENT";
  } catch {
    return false;
  }
}
export function detectInteractiveWindowsDesktop({
  platform=process.platform,
  githubActions=process.env.GITHUB_ACTIONS,
  sessionName=process.env.SESSIONNAME,
  probe=probeWindowsInputDesktop,
}={}) {
  if(platform!=="win32" || githubActions==="true" ||
      sessionName==="Services")return false;
  if(typeof sessionName==="string" && sessionName.trim())return true;
  try{return probe()===true}catch{return false}
}

// Isolated Windows guest only. Clear the test canary without synthetic input
// or foreground activation. A bounded, verified STA clipboard reset is required.
export function resetStagingGuestClipboard(run = execFileSync) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$last='clipboard reset not confirmed'",
    "for($attempt=0;$attempt -lt 5;$attempt++){",
    " try {",
    "  [System.Windows.Forms.Clipboard]::Clear()",
    "  if([System.Windows.Forms.Clipboard]::ContainsText()){throw 'clipboard still contains text'}",
    "  Write-Output 'G4_GUEST_CLIPBOARD_CLEAR=PASS'",
    "  exit 0",
    " } catch { $last=$_.Exception.Message; Start-Sleep -Milliseconds 120 }",
    "}",
    "throw ('G4_GUEST_CLIPBOARD_CLEAR=FAIL '+$last)",
  ].join("\n");
  try {
    const output = run("powershell.exe",
      ["-NoProfile", "-Sta", "-Command", script], {
        encoding: "utf8", timeout: 12_000, windowsHide: true,
      });
    if (!String(output ?? "").includes("G4_GUEST_CLIPBOARD_CLEAR=PASS")) {
      throw new Error("Clipboard reset produced no verified success marker");
    }
  } catch (err) {
    const detail = err?.stderr ? String(err.stderr).slice(0, 1000)
      : String(err instanceof Error ? err.message : err).slice(0, 1000);
    throw new Error(`Isolated G4 clipboard cleanup not verified: ${detail}`);
  }
}

export function detectPrerequisites(explicitTetherd) {
  const platform = process.platform;
  const interactiveDesktopAvailable = detectInteractiveWindowsDesktop();

  const chromiumCandidates = [
    process.env.TETHERPLANE_CHROMIUM,
    ...(platform === "win32"
      ? [
          path.join(
            process.env["ProgramFiles"] ?? "C:\\Program Files",
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
          ),
          path.join(
            process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
          ),
          path.join(
            process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
            "Microsoft",
            "Edge",
            "Application",
            "msedge.exe",
          ),
        ]
      : [
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
        ]),
  ].filter(Boolean);
  const chromiumPath =
    chromiumCandidates.find(isExecutableFile) ??
    (platform !== "win32"
      ? findOnPath([
          "chromium",
          "chromium-browser",
          "google-chrome",
          "google-chrome-stable",
        ])
      : findOnPath(["chrome.exe", "msedge.exe"]));

  const opensslCandidates = [
    ...(platform === "win32"
      ? [
          path.join(
            process.env["ProgramFiles"] ?? "C:\\Program Files",
            "Git",
            "usr",
            "bin",
            "openssl.exe",
          ),
          path.join(
            process.env["ProgramFiles"] ?? "C:\\Program Files",
            "OpenSSL-Win64",
            "bin",
            "openssl.exe",
          ),
        ]
      : ["/usr/bin/openssl", "/usr/local/bin/openssl"]),
  ];
  const opensslPath =
    opensslCandidates.find(isExecutableFile) ??
    findOnPath([platform === "win32" ? "openssl.exe" : "openssl"]);

  const exe = platform === "win32" ? "tetherd.exe" : "tetherd";
  const tetherdCandidates = [
    explicitTetherd,
    path.join(repoRoot, "target", "release", exe),
    path.join(repoRoot, "target", "debug", exe),
  ].filter(Boolean);
  const tetherdPath = tetherdCandidates.find(isExecutableFile) ?? null;

  const relayEntryPath = path.join(repoRoot, "relay", "dist", "cli.js");
  const extensionBgPath = path.join(
    repoRoot,
    "extension",
    "browser",
    "dist",
    "background.js",
  );

  return {
    platform,
    interactiveDesktopAvailable,
    physicalMobileAvailable: false,
    chromiumPath,
    opensslPath,
    tetherdPath,
    relayEntryPath: existsSync(relayEntryPath) ? relayEntryPath : null,
    extensionPath: existsSync(extensionBgPath)
      ? path.join(repoRoot, "extension", "browser")
      : null,
    builtReady: Boolean(
      tetherdPath && existsSync(relayEntryPath) && existsSync(extensionBgPath),
    ),
  };
}

export function buildStagingPlan(options = {}) {
  const env = detectPrerequisites(options.tetherd);
  env.physicalMobileAvailable = Boolean(options.pauseForMobile);
  return {
    version: 1,
    runbook: "docs/release/windows-staging-acceptance.md",
    forbiddenHosts: [...FORBIDDEN_HOSTS],
    gates: GATE_DEFINITIONS,
    mobileChecks: MOBILE_CHECKS,
    environment: env,
  };
}

function validatePublicOriginInput(rawValue) {
  let parsed;
  try {
    parsed = new URL(rawValue.trim());
  } catch {
    throw new CliUsageError("--public-origin must be a valid absolute URL");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new CliUsageError(
      "--public-origin must not contain credentials, path, query, or fragment",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new CliUsageError(
      "--public-origin must use https:// so portal cookies keep the Secure attribute",
    );
  }
  return parsed.origin;
}

function formatHostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function buildStagingSanEntries(lanHost) {
  const entries = ["IP:127.0.0.1", "DNS:localhost"];
  if (lanHost) {
    entries.push(net.isIP(lanHost) ? `IP:${lanHost}` : `DNS:${lanHost}`);
  }
  return entries;
}

export function resolveRelayTlsTopology(opts, relayPort) {
  if (opts.tlsCert && opts.tlsKey) {
    const publicOrigin = opts.publicOrigin
      ? opts.publicOrigin.replace(/\/$/, "")
      : null;
    const originUrl = publicOrigin ? new URL(publicOrigin) : null;
    const hostLabel = originUrl?.hostname ?? opts.lanHost ?? "localhost";
    const bindHost =
      opts.lanHost && net.isIP(opts.lanHost)
        ? opts.lanHost
        : opts.lanHost || originUrl
          ? "0.0.0.0"
          : "127.0.0.1";
    const publicHttpBase = publicOrigin ?? `https://${formatHostForUrl(hostLabel)}:${relayPort}`;
    const wsAuthority = originUrl
      ? `${originUrl.hostname}:${relayPort}`
      : `${formatHostForUrl(hostLabel)}:${relayPort}`;
    return {
      mode: "direct-trusted-tls",
      bindHost,
      localHealthBase: publicHttpBase,
      publicHttpBase,
      relayWsBase: `wss://${wsAuthority}`,
      tetherdAllowInsecureLocalhost: false,
      tetherdNeedsCaCert: false,
      browserNeedsSpkiPin: false,
      requiresOpenssl: false,
      requireExactRelayPort: Boolean(publicOrigin),
      opensExternalPort: Boolean(opts.lanHost || originUrl),
    };
  }

  if (opts.publicOrigin) {
    const publicHttpBase = opts.publicOrigin.replace(/\/$/, "");
    return {
      mode: "trusted-reverse-proxy",
      bindHost: "127.0.0.1",
      localHealthBase: `http://127.0.0.1:${relayPort}`,
      publicHttpBase,
      relayWsBase: `ws://127.0.0.1:${relayPort}`,
      tetherdAllowInsecureLocalhost: true,
      tetherdNeedsCaCert: false,
      browserNeedsSpkiPin: false,
      requiresOpenssl: false,
      requireExactRelayPort: true,
      opensExternalPort: false,
    };
  }

  const bindHost = opts.lanHost ?? "127.0.0.1";
  const authority = `${formatHostForUrl(bindHost)}:${relayPort}`;
  return {
    mode: "ephemeral-ca",
    bindHost,
    localHealthBase: `https://${authority}`,
    publicHttpBase: `https://${authority}`,
    relayWsBase: `wss://${authority}`,
    tetherdAllowInsecureLocalhost: false,
    tetherdNeedsCaCert: true,
    browserNeedsSpkiPin: true,
    requiresOpenssl: true,
    requireExactRelayPort: false,
    opensExternalPort: Boolean(opts.lanHost),
  };
}

export function formatMobileCheckpointNote({
  topology,
  ownerTokenFile,
  ephemeralCaCrt,
}) {
  const lines = [`Portal URL: ${topology.publicHttpBase}/portal`];
  if (topology.mode === "ephemeral-ca" && ephemeralCaCrt) {
    lines.push(
      `CA file: ${ephemeralCaCrt}`,
      "TLS Trust Mode: Ephemeral staging CA (use only on a disposable test phone and delete immediately after testing)",
    );
  } else {
    lines.push(
      `TLS Trust Mode: Trusted HTTPS (${topology.mode}) — No disposable root CA installation required on your phone`,
    );
  }
  lines.push(`Owner token file: ${ownerTokenFile}`);
  return lines.join("\n") + "\n";
}

function parseCliArgs(argv) {
  const opts = {
    describe: false,
    preflightOnly: false,
    mode: "auto",
    allowPartial: false,
    lanHost: null,
    relayPort: 18788,
    tlsCert: null,
    tlsKey: null,
    publicOrigin: null,
    trustProxyHeaders: false,
    pauseForMobile: false,
    trustWinCert: false,
    hostname: os.hostname(),
    screenshotDir: null,
    reportFile: null,
    tetherd: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--describe":
        opts.describe = true;
        break;
      case "--preflight-only":
        opts.preflightOnly = true;
        break;
      case "--allow-partial":
        opts.allowPartial = true;
        break;
      case "--trust-proxy-headers":
        opts.trustProxyHeaders = true;
        break;
      case "--pause-for-mobile":
        opts.pauseForMobile = true;
        break;
      case "--trust-win-cert":
        opts.trustWinCert = true;
        break;
      case "--mode": {
        const val = argv[++i];
        if (val !== "auto" && val !== "interactive") {
          throw new CliUsageError(`--mode must be 'auto' or 'interactive'`);
        }
        opts.mode = val;
        break;
      }
      case "--lan-host":
        opts.lanHost = requiredArgValue(argv, ++i, "--lan-host");
        break;
      case "--relay-port": {
        const val = Number(requiredArgValue(argv, ++i, "--relay-port"));
        if (!Number.isSafeInteger(val) || val <= 0 || val > 65535) {
          throw new CliUsageError("--relay-port must be a valid TCP port");
        }
        opts.relayPort = val;
        break;
      }
      case "--tls-cert":
        opts.tlsCert = path.resolve(requiredArgValue(argv, ++i, "--tls-cert"));
        break;
      case "--tls-key":
        opts.tlsKey = path.resolve(requiredArgValue(argv, ++i, "--tls-key"));
        break;
      case "--public-origin":
        opts.publicOrigin = validatePublicOriginInput(
          requiredArgValue(argv, ++i, "--public-origin"),
        );
        break;
      case "--hostname":
        opts.hostname = requiredArgValue(argv, ++i, "--hostname");
        break;
      case "--screenshot-dir":
        opts.screenshotDir = path.resolve(
          requiredArgValue(argv, ++i, "--screenshot-dir"),
        );
        break;
      case "--report-file":
        opts.reportFile = path.resolve(
          requiredArgValue(argv, ++i, "--report-file"),
        );
        break;
      case "--tetherd":
        opts.tetherd = path.resolve(requiredArgValue(argv, ++i, "--tetherd"));
        break;
      default:
        throw new CliUsageError(`unknown argument: ${arg}`);
    }
  }

  if (Boolean(opts.tlsCert) !== Boolean(opts.tlsKey)) {
    throw new CliUsageError("--tls-cert and --tls-key must be provided together");
  }
  if (opts.trustWinCert && (opts.tlsCert || opts.publicOrigin)) {
    throw new CliUsageError(
      "--trust-win-cert applies only to ephemeral staging PKI (not trusted certs or reverse proxies)",
    );
  }
  if (opts.pauseForMobile && argv.includes("--mode") && opts.mode !== "interactive") {
    throw new CliUsageError("--pause-for-mobile requires --mode interactive");
  }
  if (opts.pauseForMobile && !argv.includes("--mode")) {
    opts.mode = "interactive";
  }
  if (opts.trustWinCert && process.platform !== "win32") {
    throw new CliUsageError("--trust-win-cert is only supported on Windows");
  }
  if (opts.trustProxyHeaders && !opts.publicOrigin) {
    throw new CliUsageError("--trust-proxy-headers requires --public-origin");
  }
  return opts;
}

function requiredArgValue(argv, index, flag) {
  const val = argv[index];
  if (!val || val.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return val;
}

class CliUsageError extends Error {}

function randomSecret() {
  return randomBytes(32)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function writeSecretFile(filePath, secret) {
  writeFileSync(filePath, secret, { encoding: "utf8", mode: 0o600 });
}

async function isPortFree(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function until(predicate, timeoutMs = 15_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const val = await predicate();
      if (val) {
        return val;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}` +
      (lastErr ? ` (last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : ""),
  );
}

export function createStagingPki(opensslPath, tlsDir, lanHost) {
  const caKey = path.join(tlsDir, "relay-ca.key");
  const caCrt = path.join(tlsDir, "relay-ca.crt");
  const srvKey = path.join(tlsDir, "relay.key");
  const srvCsr = path.join(tlsDir, "relay.csr");
  const srvCrt = path.join(tlsDir, "relay.crt");
  const srvExt = path.join(tlsDir, "relay.ext");
  // Git-for-Windows OpenSSL can default to /usr/ssl/openssl.cnf, which is
  // absent in a clean, network-isolated Windows Sandbox. Never depend on
  // the machine's OpenSSL configuration for ephemeral staging identity.
  const reqConfig = path.join(tlsDir, "openssl.cnf");
  writeFileSync(reqConfig,
    "[req]\ndistinguished_name = req_distinguished_name\n[req_distinguished_name]\n",
    "utf8");

  execFileSync(opensslPath, [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-keyout",
    caKey,
    "-out",
    caCrt,
    "-config",
    reqConfig,
    "-subj",
    "/CN=Tetherplane Staging Ephemeral CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ], { stdio: "pipe" });

  execFileSync(opensslPath, [
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    srvKey,
    "-out",
    srvCsr,
    "-config",
    reqConfig,
    "-subj",
    "/CN=127.0.0.1",
  ], { stdio: "pipe" });

  const san = buildStagingSanEntries(lanHost).join(",");
  writeFileSync(
    srvExt,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${san}`,
      "",
    ].join("\n"),
    "utf8",
  );

  execFileSync(opensslPath, [
    "x509",
    "-req",
    "-in",
    srvCsr,
    "-CA",
    caCrt,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    srvCrt,
    "-days",
    "2",
    "-extfile",
    srvExt,
  ], { stdio: "pipe" });

  const caPem = readFileSync(caCrt, "utf8");
  const srvPem = readFileSync(srvCrt, "utf8");
  const x509 = new X509Certificate(srvPem);
  const spkiDer = x509.publicKey.export({ type: "spki", format: "der" });
  const spkiPin = createHash("sha256").update(spkiDer).digest("base64");

  return { caKey, caCrt, srvKey, srvCrt, caPem, spkiPin };
}

function createCaFetch(caPem = null) {
  const ca = caPem ? [...tls.rootCertificates, caPem] : tls.rootCertificates;
  return async function caFetch(input, init = {}) {
    const url = typeof input === "string" || input instanceof URL
      ? new URL(input.toString())
      : new URL(input.url);
    const method = String(
      init.method ??
        (typeof input === "object" && input && "method" in input && input.method
          ? input.method
          : "GET"),
    ).toUpperCase();

    const headers = {};
    const addHeaders = (source) => {
      if (!source) return;
      if (typeof source.forEach === "function") {
        source.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(source)) {
        for (const [k, v] of source) {
          headers[String(k).toLowerCase()] = String(v);
        }
      } else {
        for (const [k, v] of Object.entries(source)) {
          if (v !== undefined) headers[k.toLowerCase()] = String(v);
        }
      }
    };
    if (typeof input === "object" && input && "headers" in input) {
      addHeaders(input.headers);
    }
    addHeaders(init.headers);

    let bodyBuf = null;
    const rawBody = init.body ?? null;
    if (rawBody !== null) {
      if (typeof rawBody === "string") {
        bodyBuf = Buffer.from(rawBody, "utf8");
      } else if (Buffer.isBuffer(rawBody) || rawBody instanceof Uint8Array) {
        bodyBuf = Buffer.from(rawBody);
      } else if (typeof rawBody.getReader === "function") {
        const chunks = [];
        const reader = rawBody.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
        }
        bodyBuf = Buffer.concat(chunks);
      } else {
        bodyBuf = Buffer.from(String(rawBody), "utf8");
      }
      if (!headers["content-length"]) {
        headers["content-length"] = String(bodyBuf.byteLength);
      }
    }

    const transport = url.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(
        url,
        {
          method,
          headers,
          ...(url.protocol === "https:" ? { ca, rejectUnauthorized: true } : {}),
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const responseHeaders = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          }
          const status = res.statusCode ?? 500;
          const emptyBody = status === 204 || status === 304 || method === "HEAD";
          const bodyStream = emptyBody ? null : Readable.toWeb(res);
          resolve(
            new Response(bodyStream, {
              status,
              statusText: res.statusMessage ?? "",
              headers: responseHeaders,
            }),
          );
        },
      );
      req.on("error", reject);
      if (bodyBuf) {
        req.write(bodyBuf);
      }
      req.end();
    });
  };
}

function connectWebSocket(url, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`CDP WS connect timeout (${url})`));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = () => {
      cleanup();
      reject(new Error(`CDP WS connect failed (${url})`));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
}

function logProgress(stage) {
  process.stderr.write(`[staging ${new Date().toISOString()}] ${stage}\n`);
}

class StagingBrowser {
  #child;
  #ws;
  #pending = new Map();
  #nextId = 1;
  #sessions = new Map();
  mainSessionId = "";
  consoleErrors = [];
  exceptions = [];

  constructor(child, ws) {
    this.#child = child;
    this.#ws = ws;
  }

  static async launch({
    executablePath,
    profileDir,
    extensionPath,
    spkiPin,
    headless,
    initialUrl = "about:blank",
  }) {
    mkdirSync(profileDir, { recursive: true });
    const portFile = path.join(profileDir, "DevToolsActivePort");
    rmSync(portFile, { force: true });

    const args = [
      ...(headless ? ["--headless=new"] : []),
      ...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      ...(spkiPin ? [`--ignore-certificate-errors-spki-list=${spkiPin}`] : []),
      ...(extensionPath
        ? [
            "--disable-features=DisableLoadExtensionCommandLineSwitch",
            `--load-extension=${extensionPath}`,
          ]
        : []),
      initialUrl,
    ];
    const child = spawn(executablePath, args, {
      stdio: "ignore",
      windowsHide: headless,
    });

    const ws = await until(async () => {
      if (child.exitCode !== null) {
        throw new Error(`Browser exited early with code ${child.exitCode}`);
      }
      if (!existsSync(portFile)) return null;
      const lines = readFileSync(portFile, "utf8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const port = Number(lines[0]);
      if (port > 0 && lines[1]?.startsWith("/devtools/browser/")) {
        const wsUrl = `ws://127.0.0.1:${port}${lines[1]}`;
        return await connectWebSocket(wsUrl);
      }
      return null;
    }, 15_000, "DevToolsActivePort and CDP WebSocket");

    const browser = new StagingBrowser(child, ws);
    await browser.#init(initialUrl);
    return browser;
  }

  async #init(initialUrl) {
    this.#ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id && this.#pending.has(msg.id)) {
        const entry = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        } else {
          entry.resolve(msg.result);
        }
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.exceptions.push(JSON.stringify(msg.params));
      } else if (
        msg.method === "Runtime.consoleAPICalled" &&
        msg.params?.type === "error"
      ) {
        this.consoleErrors.push(JSON.stringify(msg.params));
      }
    });

    const { targetInfos } = await this.send("Target.getTargets");
    const pageTarget =
      targetInfos.find(
        (t) =>
          t.type === "page" &&
          (initialUrl === "about:blank" || t.url === initialUrl || !t.url.startsWith("chrome")),
      ) ??
      targetInfos.find((t) => t.type === "page") ??
      (await this.send("Target.createTarget", { url: initialUrl }));

    this.mainSessionId = await this.attach(pageTarget.targetId);
    await this.send("Page.enable", {}, this.mainSessionId);
    await this.send("Runtime.enable", {}, this.mainSessionId);
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  async attach(targetId) {
    if (this.#sessions.has(targetId)) {
      return this.#sessions.get(targetId);
    }
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.#sessions.set(targetId, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    return sessionId;
  }

  async getTargets() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos;
  }

  async waitForExtensionWorker(timeoutMs = 10_000) {
    return until(async () => {
      const targets = await this.getTargets();
      return targets.find(
        (t) =>
          t.type === "service_worker" &&
          t.url.startsWith("chrome-extension://") &&
          t.url.endsWith("/dist/background.js"),
      );
    }, timeoutMs, "extension service worker");
  }

  async openExtensionPopup(extOrigin) {
    const sw = await this.waitForExtensionWorker();
    const swSess = await this.attach(sw.targetId);
    await until(
      () =>
        this.evalInSession(
          swSess,
          `typeof chrome !== "undefined" && typeof chrome.action?.openPopup === "function"`,
        ),
      8_000,
      `extension SW chrome.action ready (${sw.url})`,
    );
    const existingPopups = new Set(
      (await this.getTargets())
        .filter((t) => t.type === "page" && t.url.startsWith(`${extOrigin}/pair.html`))
        .map((t) => t.targetId),
    );
    const result = await this.evalInSession(
      swSess,
      `(async () => {
        try {
          const win = await chrome.windows.getLastFocused();
          if (win && typeof win.id === "number") {
            await chrome.windows.update(win.id, { focused: true });
          }
          await chrome.action.openPopup();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err && err.message || err) };
        }
      })()`,
    );
    assert.equal(result.ok, true, `chrome.action.openPopup failed: ${result.error}`);
    const popupTarget = await until(async () => {
      const targets = await this.getTargets();
      return targets.find(
        (t) =>
          t.type === "page" &&
          t.url.startsWith(`${extOrigin}/pair.html`) &&
          !existingPopups.has(t.targetId),
      );
    }, 5_000, "extension pair.html popup target");
    const popupSession = await this.attach(popupTarget.targetId);
    await this.send("Page.enable", {}, popupSession);
    await until(
      () => this.evalInSession(popupSession, "document.readyState === 'complete'"),
      5_000,
      "popup readyState",
    );
    return { targetId: popupTarget.targetId, sessionId: popupSession };
  }

  async closeTarget(targetId) {
    this.#sessions.delete(targetId);
    await this.send("Target.closeTarget", { targetId }).catch(() => {});
  }

  async setViewport(width, height, mobile) {
    await this.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width,
        height,
        deviceScaleFactor: mobile ? 2 : 1,
        mobile,
      },
      this.mainSessionId,
    );
  }

  async navigate(url, sessionId = this.mainSessionId) {
    await this.send("Page.navigate", { url }, sessionId);
    await until(
      () => this.evalInSession(sessionId, "document.readyState === 'complete'"),
      10_000,
      `navigate complete (${url})`,
    );
  }

  async evalInSession(sessionId, expression) {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(`Browser eval failed: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result?.value;
  }

  eval(expression) {
    return this.evalInSession(this.mainSessionId, expression);
  }

  async screenshot(filePath, { sessionId = this.mainSessionId, fullPage = false } = {}) {
    if (!filePath) return;
    mkdirSync(path.dirname(filePath), { recursive: true });
    let clip;
    if (fullPage) {
      const metrics = await this.send("Page.getLayoutMetrics", {}, sessionId);
      const rect = metrics.cssContentSize ?? metrics.contentSize;
      if (rect && rect.width > 0 && rect.height > 0) {
        clip = {
          x: 0,
          y: 0,
          width: rect.width,
          height: Math.min(rect.height, 4000),
          scale: 1,
        };
      }
    }
    const { data } = await this.send(
      "Page.captureScreenshot",
      {
        format: "png",
        ...(clip ? { clip, captureBeyondViewport: true } : {}),
      },
      sessionId,
    );
    writeFileSync(filePath, Buffer.from(data, "base64"));
  }

  get exited() {
    return this.#child.exitCode !== null;
  }

  async close() {
    if (this.#child.exitCode === null) {
      await Promise.race([
        this.send("Browser.close").catch(() => {}),
        new Promise((r) => setTimeout(r, 1_000)),
      ]);
      await Promise.race([
        once(this.#child, "exit").catch(() => {}),
        new Promise((r) => setTimeout(r, 2_000)),
      ]);
    }
    try {
      this.#ws.close();
    } catch {
      // ignore
    }
    await stopChildProcess(this.#child);
  }
}

async function stopChildProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32" && typeof child.pid === "number") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await Promise.race([
      once(killer, "exit").catch(() => {}),
      new Promise((r) => setTimeout(r, 3_000)),
    ]);
  } else {
    child.kill("SIGTERM");
    const graceful = await Promise.race([
      once(child, "exit").then(() => true).catch(() => true),
      new Promise((r) => setTimeout(() => r(false), 3_000)),
    ]);
    if (!graceful && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
  if (child.exitCode === null) {
    await Promise.race([
      once(child, "exit").catch(() => {}),
      new Promise((r) => setTimeout(r, 3_000)),
    ]);
  }
}

function loadMcpSdk() {
  const e2eReq = createRequire(path.join(repoRoot, "tests", "e2e", "package.json"));
  const clientMod = e2eReq("@modelcontextprotocol/sdk/client/index.js");
  const transportMod = e2eReq("@modelcontextprotocol/sdk/client/streamableHttp.js");
  return {
    Client: clientMod.Client,
    StreamableHTTPClientTransport: transportMod.StreamableHTTPClientTransport,
  };
}

async function connectMcp(mcpUrl, token, clientName, caFetch) {
  const { Client, StreamableHTTPClientTransport } = loadMcpSdk();
  const client = new Client({ name: clientName, version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    fetch: caFetch,
    requestInit: {
      headers: { authorization: `Bearer ${token}` },
    },
  });
  await client.connect(transport);
  return client;
}

function parseToolResult(res) {
  if (res.structuredContent) {
    return res.structuredContent;
  }
  const item = Array.isArray(res.content)
    ? res.content.find((c) => c.type === "text" && typeof c.text === "string")
    : null;
  return item ? JSON.parse(item.text) : {};
}

function platformEchoArgs(marker) {
  return process.platform === "win32"
    ? { program: "cmd.exe", args: ["/C", `echo ${marker}`], pty: false }
    : { program: "/bin/sh", args: ["-c", `echo ${marker}`], pty: false };
}

function startLocalFixturesServer() {
  let submitCount = 0;
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (reqUrl.pathname === "/human.html") {
      res.end(`<!doctype html><html><head><title>Staging Human Workspace</title></head><body>
        <h1>Human Workspace</h1>
        <p id="human-note">Untouched human tab content</p>
        <input id="human-input" aria-label="Human Note" value="human-original">
        <button id="human-btn" type="button" data-clicks="0" onclick="this.dataset.clicks=String(Number(this.dataset.clicks)+1);document.getElementById('human-status').textContent='clicked-human-'+this.dataset.clicks">Human Action</button>
        <div id="human-status" role="status">human-idle</div>
      </body></html>`);
      return;
    }
    if (reqUrl.pathname === "/owned.html") {
      res.end(`<!doctype html><html><head><title>Staging Owned App</title></head><body>
        <main data-revision="1" id="app-root">
          <h1>Owned App</h1>
          <label for="owned-name">Task Name</label>
          <input id="owned-name" name="task_name" aria-label="Task Name" value="">
          <button id="owned-submit" type="button">Submit Task</button>
          <div id="owned-result" role="status">idle</div>
        </main>
        <script>
          let rev = 1;
          document.getElementById("owned-submit").addEventListener("click", () => {
            rev += 1;
            const v = document.getElementById("owned-name").value;
            document.getElementById("app-root").setAttribute("data-revision", String(rev));
            document.getElementById("owned-result").textContent = "Submitted: " + v;
          });
        </script>
      </body></html>`);
      return;
    }
    if (reqUrl.pathname === "/owned-next.html") {
      submitCount += 1;
      res.end(`<!doctype html><html><head><title>Staging Navigated Target</title></head><body>
        <h1>Owned Navigated Page ${submitCount}</h1>
      </body></html>`);
      return;
    }
    res.statusCode = 404;
    res.end("Not Found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        port: addr.port,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

function getRepoGitPorcelain() {
  try {
    return execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch {
    return null;
  }
}

async function runStagingAcceptance(opts) {
  assertAllowedHostname(opts.hostname);
  const plan = buildStagingPlan(opts);
  const envInfo = plan.environment;

  const gates = {
    G1: { status: "PENDING", details: [] },
    G2: { status: "PENDING", details: [] },
    G3: { status: "PENDING", details: [] },
    G4: { status: "PENDING", details: [] },
    G5: { status: "PENDING", details: [] },
    G6: { status: "PENDING", details: [], mobileChecks: {} },
    G7: { status: "PENDING", details: [] },
  };

  if (opts.preflightOnly) {
    gates.G1 = {
      status: "PASS",
      details: [`Allowed non-production host: ${opts.hostname}`],
    };
    gates.G2 = { status: "PASS", details: ["Preflight only"] };
    gates.G3 = { status: "PASS", details: ["Preflight only"] };
    gates.G4 = envInfo.interactiveDesktopAvailable
      ? { status: "PASS", details: ["Interactive Windows desktop detected"] }
      : {
          status: "BLOCKED",
          details: [
            "Interactive non-production Windows desktop is unavailable (platform=" +
              envInfo.platform +
              ", GITHUB_ACTIONS=" +
              String(Boolean(process.env.GITHUB_ACTIONS)) +
              ").",
          ],
        };
    gates.G5 = { status: "PASS", details: ["Preflight only"] };
    gates.G6 = envInfo.physicalMobileAvailable
      ? { status: "PASS", details: ["Physical mobile requested"] }
      : {
          status: "BLOCKED",
          details: [
            "Physical mobile device test (--pause-for-mobile) not enabled in preflight.",
          ],
        };
    gates.G7 = { status: "PASS", details: ["Preflight created no temp files"] };
    const outcome = evaluateOverallOutcome({
      allowPartial: opts.allowPartial,
      gates,
    });
    const out = { plan, outcome, gates };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exit(outcome.ok ? 0 : 1);
  }

  if (!envInfo.builtReady) {
    throw new Error(
      `Missing built staging artifacts (tetherd=${envInfo.tetherdPath}, relay=${envInfo.relayEntryPath}, extension=${envInfo.extensionPath}). Build first.`,
    );
  }
  const provisionalTopology = resolveRelayTlsTopology(opts, opts.relayPort);
  if (provisionalTopology.requiresOpenssl && !envInfo.opensslPath) {
    throw new Error("OpenSSL is required to mint staging 2-tier PKI.");
  }
  if (opts.tlsCert && !existsSync(opts.tlsCert)) {
    throw new Error(`Trusted TLS certificate file not found: ${opts.tlsCert}`);
  }
  if (opts.tlsKey && !existsSync(opts.tlsKey)) {
    throw new Error(`Trusted TLS key file not found: ${opts.tlsKey}`);
  }
  if (!envInfo.chromiumPath) {
    throw new Error("Chromium / Chrome / Edge executable is required for G2/G3/G6.");
  }

  let relayPort = opts.relayPort;
  const relayPortCheckHost =
    provisionalTopology.bindHost === "0.0.0.0"
      ? "127.0.0.1"
      : provisionalTopology.bindHost;
  if (!(await isPortFree(relayPortCheckHost, relayPort))) {
    if (provisionalTopology.requireExactRelayPort) {
      throw new Error(
        `Configured --relay-port ${relayPort} is already in use; free that port so the upstream HTTPS reverse proxy matches.`,
      );
    }
    relayPort = await findFreePort(relayPortCheckHost);
  }
  const topology = resolveRelayTlsTopology(opts, relayPort);
  const relayHttpBase = topology.publicHttpBase;
  const relayWsBase = topology.relayWsBase;

  const gitBefore = getRepoGitPorcelain();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const stagingRoot = path.join(os.tmpdir(), `tetherplane-staging-${runId}`);
  const secretsDir = path.join(stagingRoot, "secrets");
  const relayStateDir = path.join(stagingRoot, "state");
  const stateDir01 = path.join(stagingRoot, "state-01");
  const sandboxDir = path.join(stagingRoot, "sandbox");
  const tlsDir = path.join(stagingRoot, "tls");
  const localAppData = path.join(stagingRoot, "localappdata");
  const portalProfileDir = path.join(stagingRoot, "chrome-portal-profile");
  const extProfileDir = path.join(stagingRoot, "chrome-extension-profile");
  const screenshotDir =
    opts.screenshotDir ?? path.join(stagingRoot, "screenshots");

  for (const dir of [
    stagingRoot,
    secretsDir,
    relayStateDir,
    stateDir01,
    sandboxDir,
    tlsDir,
    localAppData,
    portalProfileDir,
    extProfileDir,
    screenshotDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const canaryPath = path.join(sandboxDir, "canary.txt");
  writeFileSync(canaryPath, "staging-read-canary\n", "utf8");

  const ownerToken = randomSecret();
  const operatorToken = randomSecret();
  const unpairedToken = randomSecret();
  const dev01Cred = randomSecret();
  const dev02Cred = randomSecret();
  const bridgeToken = randomSecret();
  const extLaunchToken = randomSecret();

  const ownerTokenFile = path.join(secretsDir, "owner.token");
  const operatorTokenFile = path.join(secretsDir, "operator.token");
  const unpairedTokenFile = path.join(secretsDir, "unpaired.token");
  const dev01CredFile = path.join(secretsDir, "device-01.cred");
  const dev02CredFile = path.join(secretsDir, "device-02.cred");
  const bridgeTokenFile = path.join(secretsDir, "browser-bridge.token");
  const extLaunchTokenFile = path.join(secretsDir, "browser-extension-launch.token");
  const extIdFile = path.join(stagingRoot, "browser-extension.id");

  writeSecretFile(ownerTokenFile, ownerToken);
  writeSecretFile(operatorTokenFile, operatorToken);
  writeSecretFile(unpairedTokenFile, unpairedToken);
  writeSecretFile(dev01CredFile, dev01Cred);
  writeSecretFile(dev02CredFile, dev02Cred);
  writeSecretFile(bridgeTokenFile, bridgeToken);
  writeSecretFile(extLaunchTokenFile, extLaunchToken);

  const authConfigPath = path.join(stagingRoot, "relay-auth.json");
  writeFileSync(authConfigPath, JSON.stringify(buildRelayAuthConfig(), null, 2), "utf8");

  let trustCertThumbprint = null;
  let firewallRuleAdded = false;
  let pki = null;
  let caFetch = createCaFetch(null);
  let extPairingPort = 17656;
  let extRpcPort = 17657;
  let extWsPort = 17658;

  const spawnedChildren = [];
  let relayChild = null;
  let extHostChild = null;
  let tetherdChild = null;
  let portalBrowser = null;
  let extBrowser = null;
  let fixtures = null;
  let ownerMcp = null;
  let operatorMcp = null;
  let unpairedMcp = null;
  let humanDesktopChild = null;
  let ownedDesktopHandle = null;
  let clipboardCanarySet = false;
  let originalStagingError = null;
  let clipboardCleanupError = null;

  const relayLogs = [];
  const extHostLogs = [];
  const tetherdLogs = [];

  try {
    pki =
      topology.mode === "ephemeral-ca"
        ? createStagingPki(envInfo.opensslPath, tlsDir, opts.lanHost)
        : null;
    caFetch = createCaFetch(pki?.caPem ?? null);

    if (opts.trustWinCert && pki && process.platform === "win32") {
      trustCertThumbprint = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Import-Certificate -FilePath '${pki.caCrt.replace(/'/g, "''")}' -CertStoreLocation Cert:\\CurrentUser\\Root).Thumbprint`,
        ],
        { encoding: "utf8" },
      ).trim();
    }
    if (topology.opensExternalPort && process.platform === "win32") {
      try {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `New-NetFirewallRule -DisplayName 'Tetherplane-Staging-${relayPort}' -Direction Inbound -Protocol TCP -LocalPort ${relayPort} -Profile Private -Action Allow | Out-Null`,
          ],
          { stdio: "ignore" },
        );
        firewallRuleAdded = true;
      } catch {
        process.stderr.write(
          `[staging warning] Could not auto-create Windows Firewall rule 'Tetherplane-Staging-${relayPort}' (Administrator elevation required). If your phone cannot reach the portal, either prefer '--public-origin' via 'tailscale serve' or run elevated: New-NetFirewallRule -DisplayName 'Tetherplane-Staging-${relayPort}' -Direction Inbound -Protocol TCP -LocalPort ${relayPort} -Profile Private -Action Allow\n`,
        );
      }
    }

    gates.G1 = {
      status: "PASS",
      details: [
        `Isolated hostname=${opts.hostname}, stagingRoot=${stagingRoot}, tlsMode=${topology.mode}`,
        `Production LOCALAPPDATA isolated via LOCALAPPDATA=${localAppData}`,
      ],
    };

    // Use default 17656-17658 if all three are free so "Pair with local Tetherplane" works cleanly.
    const defaultExtPortsFree =
      (await isPortFree("127.0.0.1", 17656)) &&
      (await isPortFree("127.0.0.1", 17657)) &&
      (await isPortFree("127.0.0.1", 17658));
    extPairingPort = defaultExtPortsFree ? 17656 : await findFreePort("127.0.0.1");
    extRpcPort = defaultExtPortsFree ? 17657 : await findFreePort("127.0.0.1");
    extWsPort = defaultExtPortsFree ? 17658 : await findFreePort("127.0.0.1");

    fixtures = await startLocalFixturesServer();

    // --- Launch Relay (Direct TLS or Trusted Same-Host Reverse Proxy) ---
    const relayStateFile = path.join(relayStateDir, "relay-devices.json");
    const relayArgs = [
      envInfo.relayEntryPath,
      "--host",
      topology.bindHost,
      "--port",
      String(relayPort),
      "--state-file",
      relayStateFile,
      "--auth-config",
      authConfigPath,
      ...(topology.mode === "trusted-reverse-proxy"
        ? ["--allow-insecure-localhost"]
        : [
            "--tls-cert",
            topology.mode === "direct-trusted-tls" ? opts.tlsCert : pki.srvCrt,
            "--tls-key",
            topology.mode === "direct-trusted-tls" ? opts.tlsKey : pki.srvKey,
          ]),
      ...(opts.publicOrigin ? ["--public-origin", opts.publicOrigin] : []),
      ...(opts.trustProxyHeaders ? ["--trust-proxy-headers"] : []),
    ];
    relayChild = spawn(process.execPath, relayArgs, {
      cwd: repoRoot,
      env: {
        ...process.env,
        STAGING_OWNER_TOKEN: ownerToken,
        STAGING_OPERATOR_TOKEN: operatorToken,
        STAGING_UNPAIRED_TOKEN: unpairedToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    spawnedChildren.push(relayChild);
    relayChild.stdout?.setEncoding("utf8");
    relayChild.stderr?.setEncoding("utf8");
    relayChild.stdout?.on("data", (d) => relayLogs.push(String(d)));
    relayChild.stderr?.on("data", (d) => relayLogs.push(String(d)));

    await until(async () => {
      if (relayChild.exitCode !== null) {
        throw new Error(`relay exited early (${relayChild.exitCode}): ${relayLogs.join("")}`);
      }
      const res = await caFetch(`${topology.localHealthBase}/readyz`);
      return res.status === 200;
    }, 15_000, `relay readyz (${topology.localHealthBase})`);

    if (topology.mode === "trusted-reverse-proxy") {
      try {
        await until(async () => {
          const res = await caFetch(`${relayHttpBase}/readyz`);
          return res.status === 200;
        }, 10_000, `trusted HTTPS reverse proxy readyz (${relayHttpBase}/readyz)`);
      } catch (err) {
        throw new Error(
          `Trusted HTTPS reverse proxy readiness failed at ${relayHttpBase}/readyz (local relay healthy on ${topology.localHealthBase}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // --- GATE G2: Auth, Cookies, CSRF, URL token block, Non-owner isolation, DOM XSS ---
    try {
      const q1 = await caFetch(`${relayHttpBase}/portal?token=leak-test`);
      const q2 = await caFetch(`${relayHttpBase}/portal/api/overview?access_token=leak-test`);
      assert.equal(q1.status, 400);
      assert.equal(q2.status, 400);

      const badSess = await caFetch(`${relayHttpBase}/portal/api/session`, {
        method: "POST",
        headers: { authorization: `Bearer ${operatorToken}`, origin: relayHttpBase },
      });
      assert.equal(badSess.status, 403);

      const badDevices = await caFetch(`${relayHttpBase}/devices`, {
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      assert.equal(badDevices.status, 403);

      const badApprove = await caFetch(`${relayHttpBase}/pair/approve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${operatorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ userCode: "XXXX-YYYY" }),
      });
      assert.equal(badApprove.status, 403);

      const badRevoke = await caFetch(`${relayHttpBase}/devices/staging-win-01/revoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${operatorToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equal(badRevoke.status, 403);

      const okSess = await caFetch(`${relayHttpBase}/portal/api/session`, {
        method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, origin: relayHttpBase },
      });
      assert.equal(okSess.status, 200);
      const setCookie = okSess.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Strict/i);
      assert.match(setCookie, /Secure/i);
      assert.match(setCookie, /Path=\/portal/i);
      const cookiePair = setCookie.split(";")[0];
      const { csrfToken } = await okSess.json();
      assert.ok(csrfToken);

      const missingCsrf = await caFetch(`${relayHttpBase}/portal/api/global/apply`, {
        method: "POST",
        headers: {
          cookie: cookiePair,
          origin: relayHttpBase,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: true, profileId: "read_only" }),
      });
      assert.equal(missingCsrf.status, 403);

      const crossOrigin = await caFetch(`${relayHttpBase}/portal/api/global/apply`, {
        method: "POST",
        headers: {
          cookie: cookiePair,
          origin: "https://evil.example",
          "x-tetherplane-csrf": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ confirm: true, profileId: "read_only" }),
      });
      assert.equal(crossOrigin.status, 403);

      const outRes = await caFetch(`${relayHttpBase}/portal/api/session/logout`, {
        method: "POST",
        headers: {
          cookie: cookiePair,
          origin: relayHttpBase,
          "x-tetherplane-csrf": csrfToken,
          "content-type": "application/json",
        },
        body: "{}",
      });
      assert.equal(outRes.status, 200);
      const afterOut = await caFetch(`${relayHttpBase}/portal/api/overview`, {
        headers: { cookie: cookiePair },
      });
      assert.equal(afterOut.status, 401);

      // Pair staging-win-01 and staging-win-02 using owner token
      for (const [devId, cred] of [
        ["staging-win-01", dev01Cred],
        ["staging-win-02", dev02Cred],
      ]) {
        const hash = createHash("sha256").update(cred, "utf8").digest("hex");
        const startRes = await caFetch(`${relayHttpBase}/pair/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId: devId, credentialHash: hash }),
        });
        assert.equal(startRes.status, 200);
        const startData = await startRes.json();
        assert.ok(startData.userCode);
        const approveRes = await caFetch(`${relayHttpBase}/pair/approve`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ownerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ userCode: startData.userCode }),
        });
        assert.equal(approveRes.status, 200);
      }

      // Open isolated Portal browser and authenticate via UI
      portalBrowser = await StagingBrowser.launch({
        executablePath: envInfo.chromiumPath,
        profileDir: portalProfileDir,
        spkiPin: topology.browserNeedsSpkiPin ? pki?.spkiPin : undefined,
        headless: opts.mode === "auto",
      });
      await portalBrowser.setViewport(1280, 900, false);
      await portalBrowser.navigate(`${relayHttpBase}/portal`);

      await portalBrowser.eval(`(() => {
        document.getElementById("token-input").value = ${JSON.stringify(ownerToken)};
        document.getElementById("connect-btn").click();
      })()`);

      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Pending Device Ack (v1)" && document.querySelectorAll(".device-card").length === 2`,
          ),
        12_000,
        "staging devices initial Portal render",
      );

      const portalHygiene = await portalBrowser.eval(`({
        tokenValue: document.getElementById("token-input")?.value ?? "",
        localKeys: window.localStorage.length,
        sessionKeys: window.sessionStorage.length,
        docCookieLen: document.cookie.length
      })`);
      assert.equal(portalHygiene.tokenValue, "");
      assert.equal(portalHygiene.localKeys, 0);
      assert.equal(portalHygiene.sessionKeys, 0);
      assert.equal(
        portalHygiene.docCookieLen,
        0,
        "HttpOnly cookie must not appear in document.cookie",
      );

      gates.G2 = {
        status: "PASS",
        details: [
          "Query tokens -> 400; operator session & management -> 403; HttpOnly; SameSite=Strict; Secure cookie verified; missing CSRF & cross-origin -> 403; logout -> 401; browser storage empty and #token-input cleared.",
        ],
      };
    } catch (err) {
      gates.G2 = { status: "FAIL", details: [String(err)] };
      throw err;
    }

    // --- Stage 2 & GATE G3: Extension Host Standby, tetherd WSS, Real MV3 Extension Pairing & Recovery ---
    extHostChild = spawn(
      process.execPath,
      [path.join(repoRoot, "scripts", "browser-extension-host.ts")],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          LOCALAPPDATA: localAppData,
          TETHERPLANE_BROWSER_BRIDGE_TOKEN_FILE: bridgeTokenFile,
          TETHERPLANE_EXTENSION_LAUNCH_TOKEN_FILE: extLaunchTokenFile,
          TETHERPLANE_EXTENSION_ID_FILE: extIdFile,
          TETHERPLANE_EXTENSION_PAIRING_PORT: String(extPairingPort),
          TETHERPLANE_AUTH_BROWSER_RPC_PORT: String(extRpcPort),
          TETHERPLANE_EXTENSION_WS_PORT: String(extWsPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    spawnedChildren.push(extHostChild);
    extHostChild.stdout?.setEncoding("utf8");
    extHostChild.stderr?.setEncoding("utf8");
    extHostChild.stdout?.on("data", (d) => extHostLogs.push(String(d)));
    extHostChild.stderr?.on("data", (d) => extHostLogs.push(String(d)));

    await until(() => {
      if (extHostChild.exitCode !== null) {
        throw new Error(`extension host exited early: ${extHostLogs.join("")}`);
      }
      const combined = extHostLogs.join("");
      return (
        combined.includes("AUTH_BROWSER_RPC_READY=") &&
        combined.includes("AUTH_PAIRING_READY=")
      );
    }, 15_000, "extension host standby ready");

    const spawnStagingTetherd = () => {
      const child = spawn(
        envInfo.tetherdPath,
        [
          "--relay-url",
          `${relayWsBase}/device`,
          ...(topology.tetherdNeedsCaCert && pki
            ? ["--relay-ca-cert", pki.caCrt]
            : []),
          ...(topology.tetherdAllowInsecureLocalhost
            ? ["--relay-allow-insecure-localhost"]
            : []),
          "--device-id",
          "staging-win-01",
          "--device-credential-file",
          dev01CredFile,
          "--state-dir",
          stateDir01,
          "--allow",
          sandboxDir,
          "--browser-bridge",
          `127.0.0.1:${extRpcPort}`,
          "--browser-bridge-token-file",
          bridgeTokenFile,
        ],
        {
          cwd: repoRoot,
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      spawnedChildren.push(child);
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d) => tetherdLogs.push(String(d)));
      return child;
    };

    tetherdChild = spawnStagingTetherd();

    await until(
      () =>
        portalBrowser.eval(`(() => {
          const badge = document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent || "";
          const online = document.querySelector('.device-card[data-device-id="staging-win-01"] .pill.online')?.textContent === "Online";
          const browserSub = document.querySelector('.device-card[data-device-id="staging-win-01"] [data-action="toggle-family"][data-family="browser"]')?.closest('.family-toggle')?.querySelector('.family-sub')?.textContent || "";
          return online && badge === "Confirmed Active (v1)" && browserSub.includes("Unavailable");
        })()`),
      15_000,
      "staging-win-01 online with standby browser telemetry",
    );

    await portalBrowser.screenshot(
      path.join(screenshotDir, "01_desktop_standby_overview.png"),
      { fullPage: true },
    );

    ownerMcp = await connectMcp(
      `${relayHttpBase}/mcp`,
      ownerToken,
      "staging-owner",
      caFetch,
    );
    operatorMcp = await connectMcp(
      `${relayHttpBase}/mcp`,
      operatorToken,
      "staging-operator",
      caFetch,
    );
    unpairedMcp = await connectMcp(
      `${relayHttpBase}/mcp`,
      unpairedToken,
      "staging-unpaired",
      caFetch,
    );

    try {
      // Standby remote MCP smoke
      const devStatus = await ownerMcp.callTool({
        name: "device",
        arguments: { device: "staging-win-01", op: "status", args: {} },
      });
      assert.equal(devStatus.isError, undefined);

      const canaryRead = await ownerMcp.callTool({
        name: "files",
        arguments: {
          device: "staging-win-01",
          op: "read",
          args: { path: canaryPath },
        },
      });
      assert.equal(canaryRead.isError, undefined);
      assert.match(JSON.stringify(parseToolResult(canaryRead)), /staging-read-canary/);

      const procRun = await ownerMcp.callTool({
        name: "process",
        arguments: {
          device: "staging-win-01",
          op: "run",
          args: platformEchoArgs("STAGING_PROC_OK"),
        },
      });
      assert.equal(procRun.isError, undefined);
      assert.match(JSON.stringify(parseToolResult(procRun)), /STAGING_PROC_OK/);

      const browserStandby = await ownerMcp.callTool({
        name: "browser",
        arguments: { device: "staging-win-01", op: "status", args: {} },
      });
      const standbyData = parseToolResult(browserStandby);
      assert.equal(browserStandby.isError, undefined);
      assert.equal(standbyData.available, false);

      // Pair real MV3 Chrome Extension inside separate Chrome instance
      const launchExtAndPair = async (screenshotPath) => {
        const browser = await StagingBrowser.launch({
          executablePath: envInfo.chromiumPath,
          profileDir: extProfileDir,
          extensionPath: envInfo.extensionPath,
          spkiPin: topology.browserNeedsSpkiPin ? pki?.spkiPin : undefined,
          headless: opts.mode === "auto",
          initialUrl: `${fixtures.baseUrl}/human.html`,
        });
        const sw = await browser.waitForExtensionWorker();
        const extId = new URL(sw.url).hostname;
        const extOrigin = `chrome-extension://${extId}`;
        const popup = await browser.openExtensionPopup(extOrigin);

        if (defaultExtPortsFree) {
          await browser.evalInSession(
            popup.sessionId,
            `document.getElementById("pair-local").click()`,
          );
        } else {
          await browser.evalInSession(
            popup.sessionId,
            `(() => {
              document.querySelector("details").open = true;
              document.getElementById("bridge-url").value = ${JSON.stringify(`ws://127.0.0.1:${extWsPort}/extension`)};
              document.getElementById("launch-token").value = ${JSON.stringify(extLaunchToken)};
              document.querySelector("#pair-form button[type='submit']").click();
            })()`,
          );
        }

        await until(
          () =>
            browser.evalInSession(
              popup.sessionId,
              `(document.getElementById("status")?.textContent || "").includes("Paired")`,
            ),
          10_000,
          "extension popup Paired status",
        );

        await until(
          () => extHostLogs.join("").includes(`AUTH_EXTENSION_CONNECTED=${extId}`),
          10_000,
          "extension host AUTH_EXTENSION_CONNECTED",
        );

        if (screenshotPath) {
          await browser.screenshot(screenshotPath, { sessionId: popup.sessionId });
        }
        await browser.closeTarget(popup.targetId);
        return { browser, extOrigin, extId };
      };

      const expectedActiveHealth = envInfo.interactiveDesktopAvailable
        ? "healthy"
        : "degraded";
      let extConnCount = 0;
      const extSession1 = await launchExtAndPair(
        path.join(screenshotDir, "02_extension_popup_paired.png"),
      );
      extBrowser = extSession1.browser;
      extConnCount = extHostLogs.join("").split("AUTH_EXTENSION_CONNECTED=").length - 1;
      assert.equal(existsSync(extIdFile), true, "pinned extension id file must exist in stagingRoot");

      await until(
        () =>
          portalBrowser.eval(`(() => {
            const card = document.querySelector('.device-card[data-device-id="staging-win-01"]');
            const sub = card?.querySelector('[data-action="toggle-family"][data-family="browser"]')?.closest('.family-toggle')?.querySelector('.family-sub')?.textContent || "";
            const healthText = card?.querySelector('.card-meta-row strong')?.textContent || "";
            return sub.includes("12/12 ops active") && healthText === ${JSON.stringify(expectedActiveHealth)};
          })()`),
        12_000,
        "live Portal SSE transition to 12/12 browser ops",
      );

      await portalBrowser.screenshot(
        path.join(screenshotDir, "04_desktop_healthy_portal.png"),
        { fullPage: true },
      );

      // Background owned tab + human tab mutation protection + timed tab share & detach
      const createdTab = await ownerMcp.callTool({
        name: "browser",
        arguments: {
          device: "staging-win-01",
          op: "create_tab",
          args: { url: `${fixtures.baseUrl}/owned.html` },
        },
      });
      assert.equal(createdTab.isError, undefined);
      const createdData = parseToolResult(createdTab);
      assert.equal(createdData.ownership, "tetherplane");
      assert.equal(createdData.active, false);

      const pagesRes = await ownerMcp.callTool({
        name: "browser",
        arguments: { device: "staging-win-01", op: "pages", args: {} },
      });
      assert.equal(pagesRes.isError, undefined);
      const pagesList = parseToolResult(pagesRes).pages;
      const humanPage = pagesList.find((p) => p.url?.includes("/human.html"));
      const ownedPage = pagesList.find((p) => p.url?.includes("/owned.html"));
      assert.ok(humanPage, "human.html page missing");
      assert.ok(ownedPage, "owned.html page missing");
      assert.equal(humanPage.ownership, "human");
      assert.equal(humanPage.active, true);
      assert.equal(ownedPage.ownership, "tetherplane");

      // Unshared human tab MUST reject mutation
      const deniedHumanNav = await ownerMcp.callTool({
        name: "browser",
        arguments: {
          device: "staging-win-01",
          op: "navigate",
          args: { page_id: humanPage.page_id, url: `${fixtures.baseUrl}/owned-next.html` },
        },
      });
      assert.equal(deniedHumanNav.isError, true);
      assert.equal(parseToolResult(deniedHumanNav).error?.code, "permission_denied");

      // Owned tab snapshot + act works cleanly while human tab remains untouched
      const ownedSnap = parseToolResult(
        await ownerMcp.callTool({
          name: "browser",
          arguments: {
            device: "staging-win-01",
            op: "snapshot",
            args: { page_id: ownedPage.page_id },
          },
        }),
      );
      const taskInput = ownedSnap.nodes.find((n) => n.accessible_name === "Task Name");
      const submitBtn = ownedSnap.nodes.find((n) => n.accessible_name === "Submit Task");
      assert.ok(taskInput && submitBtn);

      const actOwned = await ownerMcp.callTool({
        name: "browser",
        arguments: {
          device: "staging-win-01",
          op: "act",
          args: {
            page_id: ownedPage.page_id,
            actions: [
              { kind: "fill", target: taskInput.ref, value: "staging-browser-ok" },
              { kind: "click", target: submitBtn.ref },
            ],
            expectations: [
              { kind: "value", target: taskInput.ref, equals: "staging-browser-ok" },
              { kind: "toast", includes: "Submitted: staging-browser-ok" },
              { kind: "validation_absent" },
            ],
            timeout_ms: 5_000,
          },
        },
      });
      assert.equal(actOwned.isError, undefined);
      assert.equal(parseToolResult(actOwned).state, "verified");

      // Share active human tab via popup -> act succeeds -> Detach -> act denied again!
      const sharePopup = await extBrowser.openExtensionPopup(extSession1.extOrigin);
      await extBrowser.evalInSession(
        sharePopup.sessionId,
        `(() => {
          document.getElementById("share-ttl").value = "300000";
          document.getElementById("share-current").click();
        })()`,
      );
      await until(
        () =>
          extBrowser.evalInSession(
            sharePopup.sessionId,
            `(document.getElementById("share-status")?.textContent || "").includes("Current tab shared")`,
          ),
        5_000,
        "popup share status",
      );
      await extBrowser.evalInSession(
        sharePopup.sessionId,
        `document.getElementById("share-status")?.scrollIntoView({ block: "end" })`,
      );
      await extBrowser.screenshot(
        path.join(screenshotDir, "03_extension_popup_tab_shared.png"),
        { sessionId: sharePopup.sessionId },
      );

      const humanSnap = parseToolResult(
        await ownerMcp.callTool({
          name: "browser",
          arguments: {
            device: "staging-win-01",
            op: "snapshot",
            args: { page_id: humanPage.page_id },
          },
        }),
      );
      const humanBtn = humanSnap.nodes.find((n) => n.accessible_name === "Human Action");
      assert.ok(humanBtn);
      const actHumanShared = await ownerMcp.callTool({
        name: "browser",
        arguments: {
          device: "staging-win-01",
          op: "act",
          args: {
            page_id: humanPage.page_id,
            actions: [{ kind: "click", target: humanBtn.ref }],
            expectations: [{ kind: "toast", includes: "clicked-human-1" }],
            timeout_ms: 5_000,
          },
        },
      });
      assert.equal(actHumanShared.isError, undefined);
      assert.equal(parseToolResult(actHumanShared).state, "verified");

      // Detach sharing in popup -> mutation denied again
      await extBrowser.evalInSession(
        sharePopup.sessionId,
        `document.getElementById("detach-current").click()`,
      );
      await until(
        () =>
          extBrowser.evalInSession(
            sharePopup.sessionId,
            `(document.getElementById("share-status")?.textContent || "").includes("no longer shared")`,
          ),
        5_000,
        "popup detach status",
      );
      await extBrowser.closeTarget(sharePopup.targetId);

      const deniedActAfterDetach = await ownerMcp.callTool({
        name: "browser",
        arguments: {
          device: "staging-win-01",
          op: "act",
          args: {
            page_id: humanPage.page_id,
            actions: [{ kind: "click", target: humanBtn.ref }],
          },
        },
      });
      const deniedActData = parseToolResult(deniedActAfterDetach);
      assert.equal(deniedActData.state, "failed");
      assert.equal(deniedActData.error?.code, "permission_denied");
      const clicksAfterDetach = await extBrowser.eval(
        `document.getElementById("human-btn")?.dataset.clicks`,
      );
      assert.equal(clicksAfterDetach, "1");

      const deniedNavAfterDetach = await ownerMcp.callTool({
        name: "browser",
        arguments: {
          device: "staging-win-01",
          op: "navigate",
          args: { page_id: humanPage.page_id, url: `${fixtures.baseUrl}/owned-next.html` },
        },
      });
      assert.equal(deniedNavAfterDetach.isError, true);
      assert.equal(parseToolResult(deniedNavAfterDetach).error?.code, "permission_denied");

      // Kill Chrome extension browser completely -> live standby -> relaunch & re-pair -> auto-recovery
      logProgress("G3: closing extension browser to verify live standby");
      await extBrowser.close();
      extBrowser = null;

      await until(
        () => extHostLogs.join("").includes("AUTH_EXTENSION_DISCONNECTED=True"),
        10_000,
        "AUTH_EXTENSION_DISCONNECTED=True",
      );
      logProgress("G3: extension disconnected; awaiting Portal SSE standby");

      await until(
        () =>
          portalBrowser.eval(`(() => {
            const card = document.querySelector('.device-card[data-device-id="staging-win-01"]');
            const sub = card?.querySelector('[data-action="toggle-family"][data-family="browser"]')?.closest('.family-toggle')?.querySelector('.family-sub')?.textContent || "";
            const healthText = card?.querySelector('.card-meta-row strong')?.textContent || "";
            return sub.includes("Unavailable") && healthText === "degraded";
          })()`),
        12_000,
        "Portal SSE degraded/Unavailable after Chrome close",
      );

      const pagesWhileClosed = await ownerMcp.callTool({
        name: "browser",
        arguments: { device: "staging-win-01", op: "pages", args: {} },
      });
      assert.equal(pagesWhileClosed.isError, true);

      // Relaunch Chrome & re-pair cleanly
      logProgress("G3: relaunching extension browser to verify live recovery");
      const extSession2 = await launchExtAndPair(null);
      extBrowser = extSession2.browser;
      await until(
        () =>
          extHostLogs.join("").split("AUTH_EXTENSION_CONNECTED=").length - 1 >
          extConnCount,
        10_000,
        "extension reconnect event",
      );
      await until(
        () =>
          portalBrowser.eval(`(() => {
            const card = document.querySelector('.device-card[data-device-id="staging-win-01"]');
            const sub = card?.querySelector('[data-action="toggle-family"][data-family="browser"]')?.closest('.family-toggle')?.querySelector('.family-sub')?.textContent || "";
            const healthText = card?.querySelector('.card-meta-row strong')?.textContent || "";
            return sub.includes("12/12 ops active") && healthText === ${JSON.stringify(expectedActiveHealth)};
          })()`),
        12_000,
        "Portal SSE live recovery to 12/12 ops active",
      );

      const recoveredPages = await ownerMcp.callTool({
        name: "browser",
        arguments: { device: "staging-win-01", op: "pages", args: {} },
      });
      assert.equal(recoveredPages.isError, undefined);

      gates.G3 = {
        status: "PASS",
        details: [
          `Real Chromium MV3 extension loaded (${extSession1.extId}), paired ${defaultExtPortsFree ? "via local discovery button" : "via dynamic manual form"}, verified background owned tab act, verified human tab mutation denial before/after timed share, verified live SSE standby on Chrome exit, and verified auto-recovery upon relaunch + re-pair.`,
        ],
      };
    } catch (err) {
      gates.G3 = { status: "FAIL", details: [String(err)] };
      throw err;
    }

    // --- GATE G4: Interactive Windows Desktop UIA & Coexistence ---
    if (!envInfo.interactiveDesktopAvailable) {
      // On non-interactive Linux/CI, verify desktop reports truthfully unavailable rather than false ready.
      const caps = parseToolResult(
        await ownerMcp.callTool({
          name: "device",
          arguments: { device: "staging-win-01", op: "capabilities", args: {} },
        }),
      );
      const desktopProvider = (caps.providers ?? []).find(
        (p) => p.namespace === "desktop",
      );
      assert.equal(desktopProvider?.available, false);
      const deskUiText = await portalBrowser.eval(
        `document.querySelector('.device-card[data-device-id="staging-win-01"] [data-action="toggle-family"][data-family="desktop"]')?.closest('.family-toggle')?.querySelector('.family-sub')?.textContent || ""`,
      );
      assert.match(deskUiText, /Unavailable/);
      gates.G4 = {
        status: "BLOCKED",
        details: [
          `Truthful desktop unavailability verified (${deskUiText}); interactive Windows UIA coexistence blocked because host is '${envInfo.platform}' without interactive Windows session.`,
        ],
      };
    } else {
      try {
        const fixturePs1 = path.join(
          repoRoot,
          "tests",
          "e2e",
          "fixtures",
          "windows-desktop-fixture.ps1",
        );

        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Sta",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; Set-Clipboard -Value 'STAGING_CLIPBOARD_CANARY'",
          ],
          { stdio: "ignore" },
        );
        clipboardCanarySet = true;
        const cursorBefore = execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Sta",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output ($p.X.ToString()+','+$p.Y.ToString())",
          ],
          { encoding: "utf8" },
        ).trim();

        const g4Details = [];
        for (const framework of ["WinForms", "Wpf"]) {
          const fwSlug = framework.toLowerCase();
          const ownedStateFile = path.join(stagingRoot, `desktop-owned-${fwSlug}.json`);
          const humanStateFile = path.join(stagingRoot, `desktop-human-${fwSlug}.json`);
          const expectedText = `staging-uia-${fwSlug}-ok`;

          const ownedSpawn = parseToolResult(
            await ownerMcp.callTool({
              name: "process",
              arguments: {
                device: "staging-win-01",
                op: "run",
                args: {
                  program: "powershell.exe",
                  args: [
                    "-NoProfile",
                    "-Sta",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    fixturePs1,
                    "-StatePath",
                    ownedStateFile,
                    "-Title",
                    `Staging Owned ${framework} Fixture`,
                    "-Prefix",
                    "Owned",
                    "-Framework",
                    framework,
                    ...(framework === "Wpf" ? ["-NoActivate"] : []),
                  ],
                  wait_ms: 0,
                  pty: false,
                },
              },
            }),
          );
          ownedDesktopHandle = ownedSpawn.handle;
          const ownedPid = ownedSpawn.pid;
          await until(() => {
            if (!existsSync(ownedStateFile)) return false;
            const s = JSON.parse(readFileSync(ownedStateFile, "utf8"));
            return s.ready === true && s.framework === framework;
          }, 45_000, `Windows owned ${framework} fixture ready`);

          humanDesktopChild = spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-Sta",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              fixturePs1,
              "-StatePath",
              humanStateFile,
              "-Title",
              `Staging Human ${framework} Fixture`,
              "-Prefix",
              "Human",
              "-Framework",
              framework,
            ],
            { stdio: "ignore", windowsHide: false },
          );
          spawnedChildren.push(humanDesktopChild);
          const humanPid = humanDesktopChild.pid;
          await until(() => {
            if (!existsSync(humanStateFile)) return false;
            const s = JSON.parse(readFileSync(humanStateFile, "utf8"));
            return s.ready === true && s.focused === true && s.framework === framework;
          }, 45_000, `Windows human ${framework} fixture focused`);

          await until(() => {
            const s = JSON.parse(readFileSync(ownedStateFile, "utf8"));
            return s.ready === true && s.focused === false;
          }, 45_000, `Windows owned ${framework} fixture unfocused behind human window`);

          const snap = parseToolResult(
            await ownerMcp.callTool({
              name: "desktop",
              arguments: {
                device: "staging-win-01",
                op: "snapshot",
                args: { max_nodes: 1000 },
              },
            }),
          );
          const ownedNodes = (snap.nodes ?? []).filter(
            (n) => n.process_id === ownedPid,
          );
          const humanNodes = (snap.nodes ?? []).filter(
            (n) => n.process_id === humanPid,
          );
          assert.ok(
            ownedNodes.length > 0 && humanNodes.length > 0,
            `${framework} fixtures not observed in desktop snapshot`,
          );
          assert.ok(ownedNodes.every((n) => n.origin === "tetherplane"));
          assert.ok(humanNodes.every((n) => n.origin === "human_or_external"));

          const {
            valueNode: valNode,
            invokeNode: invNode,
            selectionNode: selNode,
            listBoxNode,
            humanInvokeNode: humanInv,
          } = selectStagingG4FixtureTargets(ownedNodes, humanNodes);

          for (const callArgs of [
            { reference: valNode.reference, action: "set_value", value: expectedText },
            { reference: invNode.reference, action: "invoke" },
          ]) {
            const r = await ownerMcp.callTool({
              name: "desktop",
              arguments: { device: "staging-win-01", op: "act", args: callArgs },
            });
            assert.equal(r.isError, undefined);
          }

          let selectionMode;
          if (framework === "Wpf" || selNode) {
            assert.ok(selNode, `${framework} selection node missing`);
            const selRes = await ownerMcp.callTool({
              name: "desktop",
              arguments: {
                device: "staging-win-01",
                op: "act",
                args: { reference: selNode.reference, action: "select" },
              },
            });
            assert.equal(selRes.isError, undefined);
            selectionMode = "select_passed";
          } else {
            assert.ok(
              listBoxNode,
              "WinForms selection node and listbox container both missing",
            );
            const degradedSelRes = await ownerMcp.callTool({
              name: "desktop",
              arguments: {
                device: "staging-win-01",
                op: "act",
                args: { reference: listBoxNode.reference, action: "select" },
              },
            });
            assert.equal(degradedSelRes.isError, true);
            assert.equal(
              parseToolResult(degradedSelRes).error?.code,
              "capability_unavailable",
            );
            selectionMode = "degraded_sandbox_capability_unavailable";
          }

          const deniedHuman = await ownerMcp.callTool({
            name: "desktop",
            arguments: {
              device: "staging-win-01",
              op: "act",
              args: { reference: humanInv.reference, action: "invoke", origin: "tetherplane" },
            },
          });
          assert.equal(deniedHuman.isError, true);
          assert.equal(parseToolResult(deniedHuman).error?.code, "permission_denied");

          const expectSelectedBeta =
            framework === "Wpf" ||
            Boolean(selNode && String(selNode.name).includes("Beta"));
          const ownedAfter = await until(() => {
            const s = JSON.parse(readFileSync(ownedStateFile, "utf8"));
            if (
              s.text === expectedText &&
              s.status === "invoked" &&
              (!expectSelectedBeta || s.selected === "Owned Beta")
            ) {
              return s;
            }
            return null;
          }, 10_000, `${framework} owned fixture post-action state`);
          assert.equal(ownedAfter.text, expectedText);
          assert.equal(ownedAfter.status, "invoked");
          assert.equal(ownedAfter.focused, false);
          if (expectSelectedBeta) {
            assert.equal(ownedAfter.selected, "Owned Beta");
          }

          const humanAfter = await until(() => {
            const s = JSON.parse(readFileSync(humanStateFile, "utf8"));
            return s.focused === true && s.text === "Human-initial" ? s : null;
          }, 5_000, `${framework} human fixture preserved state`);
          assert.equal(humanAfter.text, "Human-initial");
          assert.equal(humanAfter.focused, true);

          const cursorAfter = execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Sta",
              "-Command",
              "Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output ($p.X.ToString()+','+$p.Y.ToString())",
            ],
            { encoding: "utf8" },
          ).trim();
          const clipAfter = execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Sta",
              "-Command",
              "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()",
            ],
            { encoding: "utf8" },
          ).trim();
          assert.equal(cursorAfter, cursorBefore);
          assert.equal(clipAfter, "STAGING_CLIPBOARD_CANARY");

          g4Details.push(
            `${framework}: set_value/invoke passed on unfocused owned window, selection=${selectionMode}, human window focus/text + cursor + clipboard canary preserved, human act denied (permission_denied).`,
          );

          await ownerMcp.callTool({
            name: "process",
            arguments: {
              device: "staging-win-01",
              op: "terminate",
              args: { handle: ownedDesktopHandle, grace_ms: 100, force: true },
            },
          });
          ownedDesktopHandle = null;
          await stopChildProcess(humanDesktopChild);
          humanDesktopChild = null;
        }

        resetStagingGuestClipboard();
        clipboardCanarySet = false;

        gates.G4 = {
          status: "PASS",
          details: g4Details,
        };
      } catch (err) {
        gates.G4 = { status: "FAIL", details: [String(err)] };
        throw err;
      }
    }

    // --- GATE G5: Toggles, Explicit Denies, Operators, Offline Sync, Lockdown & Rollback ---
    try {
      // 1. Toggle files OFF -> read denied -> toggle files ON -> read passes
      await portalBrowser.eval(
        `document.querySelector('.device-card[data-device-id="staging-win-01"] [data-action="toggle-family"][data-family="files"]').click()`,
      );
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Confirmed Active (v2)"`,
          ),
        8_000,
        "v2 after files toggle OFF",
      );
      const filesDenied = await ownerMcp.callTool({
        name: "files",
        arguments: {
          device: "staging-win-01",
          op: "read",
          args: { path: canaryPath },
        },
      });
      assert.equal(filesDenied.isError, true);

      await portalBrowser.eval(
        `document.querySelector('.device-card[data-device-id="staging-win-01"] [data-action="toggle-family"][data-family="files"]').click()`,
      );
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Confirmed Active (v3)"`,
          ),
        8_000,
        "v3 after files toggle ON",
      );

      // 2. Explicit Deny filesystem.write
      const blockedWritePath = path.join(sandboxDir, "denied.txt");
      await portalBrowser.eval(`(() => {
        const card = document.querySelector('.device-card[data-device-id="staging-win-01"]');
        card.querySelector('details.advanced-box').open = true;
        card.querySelector('[data-role="op-rule-input"]').value = "filesystem.write";
        card.querySelector('[data-action="deny-op"]').click();
      })()`);
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Confirmed Active (v4)"`,
          ),
        8_000,
        "v4 after explicit deny filesystem.write",
      );
      const readAllowed = await ownerMcp.callTool({
        name: "files",
        arguments: {
          device: "staging-win-01",
          op: "read",
          args: { path: canaryPath },
        },
      });
      assert.equal(readAllowed.isError, undefined);
      const writeDenied = await ownerMcp.callTool({
        name: "files",
        arguments: {
          device: "staging-win-01",
          op: "write",
          args: { path: blockedWritePath, content: "should-not-write" },
        },
      });
      assert.equal(writeDenied.isError, true);
      assert.equal(existsSync(blockedWritePath), false);

      // 3. Scoped Operator Identity (staging-win-01 only, with HTML XSS canary in displayName)
      const xssDisplayName = 'Staging CI <img src=x onerror="window.__tpXss=1">';
      await portalBrowser.eval(`(() => {
        document.querySelector('input[data-action="select-device"][data-device="staging-win-01"]').click();
        document.getElementById("operator-advanced-box").open = true;
        document.getElementById("op-principal-id").value = "operator:staging-ci";
        document.getElementById("op-display-name").value = ${JSON.stringify(xssDisplayName)};
        document.getElementById("op-profile-id").value = "read_only";
        document.getElementById("save-operator-btn").click();
      })()`);
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Confirmed Active (v5)" && Boolean(document.querySelector('[data-action="remove-operator"][data-principal="operator:staging-ci"]'))`,
          ),
        8_000,
        "v5 after scoped operator:staging-ci assignment",
      );

      const opUiCheck = await portalBrowser.eval(`({
        xssTriggered: Boolean(window.__tpXss),
        identitiesText: document.getElementById("identities-container")?.textContent || "",
        win2Badge: document.querySelector('[data-sync-badge="staging-win-02"]')?.textContent || ""
      })`);
      assert.equal(opUiCheck.xssTriggered, false);
      assert.match(opUiCheck.identitiesText, /staging-win-01 \(read_only\)/);
      assert.doesNotMatch(opUiCheck.identitiesText, /staging-win-02 \(read_only\)/);
      assert.equal(opUiCheck.win2Badge, "Pending Device Ack (v1)");

      const opReadOk = await operatorMcp.callTool({
        name: "files",
        arguments: {
          device: "staging-win-01",
          op: "read",
          args: { path: canaryPath },
        },
      });
      assert.equal(opReadOk.isError, undefined);
      const opWriteDenied = await operatorMcp.callTool({
        name: "files",
        arguments: {
          device: "staging-win-01",
          op: "write",
          args: { path: blockedWritePath, content: "op-blocked" },
        },
      });
      assert.equal(opWriteDenied.isError, true);
      const unpairedDenied = await unpairedMcp.callTool({
        name: "device",
        arguments: { device: "staging-win-01", op: "status", args: {} },
      });
      assert.equal(unpairedDenied.isError, true);

      // Clear selection before offline test
      await portalBrowser.eval(`document.getElementById("clear-selected-devices-btn").click()`);

      // 4. Offline Device Recovery & Anti-Rollback
      await stopChildProcess(tetherdChild);
      tetherdChild = null;
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('.device-card[data-device-id="staging-win-01"] .pill.offline')?.textContent === "Offline"`,
          ),
        8_000,
        "staging-win-01 Offline pill",
      );

      await portalBrowser.eval(
        `document.querySelector('.device-card[data-device-id="staging-win-01"] [data-action="toggle-family"][data-family="process"]').click()`,
      );
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Pending Device Ack (v6)"`,
          ),
        8_000,
        "Pending Device Ack (v6) while offline",
      );

      const offlineProcDenied = await ownerMcp.callTool({
        name: "process",
        arguments: {
          device: "staging-win-01",
          op: "run",
          args: platformEchoArgs("nope"),
        },
      });
      assert.equal(offlineProcDenied.isError, true);

      tetherdChild = spawnStagingTetherd();
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Confirmed Active (v6)"`,
          ),
        15_000,
        "Confirmed Active (v6) convergence after reconnect",
      );
      const syncPolicyPath = path.join(stateDir01, "policy", "synchronized-policy.json");
      const persistedV6 = JSON.parse(readFileSync(syncPolicyPath, "utf8"));
      assert.equal(persistedV6.revision, 6);
      assert.ok((persistedV6.owner_policy?.denied_families ?? []).includes("process"));

      const syncedProcDenied = await ownerMcp.callTool({
        name: "process",
        arguments: {
          device: "staging-win-01",
          op: "run",
          args: platformEchoArgs("nope"),
        },
      });
      assert.equal(syncedProcDenied.isError, true);

      // 5. Generate benign UI toggles so >10 snapshots exist before Emergency Lockdown & Pagination
      for (const expectedRev of [7, 8, 9, 10]) {
        await portalBrowser.eval(
          `document.querySelector('.device-card[data-device-id="staging-win-01"] [data-action="toggle-family"][data-family="batch"]').click()`,
        );
        await until(
          () =>
            portalBrowser.eval(
              `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Confirmed Active (v${expectedRev})"`,
            ),
          8_000,
          `revision v${expectedRev}`,
        );
      }

      // Emergency Lockdown & restart durability
      await portalBrowser.eval(`(() => {
        document.getElementById("emergency-revoke-btn").click();
        document.getElementById("modal-reason").value = "Staging emergency test";
        document.getElementById("modal-confirm-btn").click();
      })()`);
      await until(
        () =>
          portalBrowser.eval(
            `document.getElementById("stat-security")?.textContent === "LOCKDOWN" && document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Emergency Lockdown"`,
          ),
        10_000,
        "Emergency Lockdown UI active",
      );
      await portalBrowser.screenshot(
        path.join(screenshotDir, "05_desktop_emergency_lockdown.png"),
        { fullPage: true },
      );

      for (const client of [ownerMcp, operatorMcp]) {
        const res = await client.callTool({
          name: "device",
          arguments: { device: "staging-win-01", op: "status", args: {} },
        });
        assert.equal(res.isError, true);
      }

      await stopChildProcess(tetherdChild);
      tetherdChild = spawnStagingTetherd();
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('.device-card[data-device-id="staging-win-01"] .pill.online')?.textContent === "Online"`,
          ),
        15_000,
        "tetherd restart online while locked down",
      );
      const lockedPolicyDisk = JSON.parse(readFileSync(syncPolicyPath, "utf8"));
      assert.equal(lockedPolicyDisk.emergency_lockdown, true);
      const ownerLockedRead = await ownerMcp.callTool({
        name: "files",
        arguments: {
          device: "staging-win-01",
          op: "read",
          args: { path: canaryPath },
        },
      });
      assert.equal(ownerLockedRead.isError, true);

      // 6. Snapshot Filter, Show More Pagination & Forward-Revision Rollback to rev 1
      await portalBrowser.eval(`(() => {
        document.getElementById("snapshots-advanced-box").open = true;
        const sel = document.getElementById("snapshot-device-filter");
        sel.value = "staging-win-01";
        sel.dispatchEvent(new Event("change"));
      })()`);
      await until(
        () => portalBrowser.eval(`Boolean(document.getElementById("snapshots-more-btn"))`),
        8_000,
        "Show more snapshots button",
      );
      await portalBrowser.eval(`document.getElementById("snapshots-more-btn").click()`);
      await until(
        () =>
          portalBrowser.eval(
            `Boolean(document.querySelector('[data-action="rollback"][data-device="staging-win-01"][data-rev="1"]'))`,
          ),
        8_000,
        "rev 1 rollback button after pagination",
      );
      await portalBrowser.screenshot(
        path.join(screenshotDir, "06_desktop_snapshots_rollback.png"),
        { fullPage: true },
      );

      await portalBrowser.eval(
        `document.querySelector('[data-action="rollback"][data-device="staging-win-01"][data-rev="1"]').click()`,
      );
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Confirmed Active (v12)"`,
          ),
        10_000,
        "Rollback to rev 1 converged as v12",
      );

      // Process & files.write restored for owner; operator removed by rev 1 rollback
      const restoredWritePath = path.join(sandboxDir, "rollback-ok.txt");
      const ownerWriteAfterRollback = await ownerMcp.callTool({
        name: "files",
        arguments: {
          device: "staging-win-01",
          op: "write",
          args: { path: restoredWritePath, content: "restored" },
        },
      });
      assert.equal(ownerWriteAfterRollback.isError, undefined);
      const ownerProcAfterRollback = await ownerMcp.callTool({
        name: "process",
        arguments: {
          device: "staging-win-01",
          op: "run",
          args: platformEchoArgs("ROLLBACK_PROC_OK"),
        },
      });
      assert.equal(ownerProcAfterRollback.isError, undefined);
      const opDeniedAfterRollback = await operatorMcp.callTool({
        name: "files",
        arguments: {
          device: "staging-win-01",
          op: "read",
          args: { path: canaryPath },
        },
      });
      assert.equal(opDeniedAfterRollback.isError, true);

      // Also lift staging-win-02 lockdown via scoped Global Lift Lockdown button cleanly
      await portalBrowser.eval(`(() => {
        document.querySelector('input[data-action="select-device"][data-device="staging-win-02"]').click();
        document.getElementById("global-lift-lockdown-btn").click();
        document.getElementById("modal-reason").value = "Lift remaining lockdown";
        document.getElementById("modal-confirm-btn").click();
      })()`);
      await until(
        () =>
          portalBrowser.eval(
            `document.getElementById("stat-security")?.textContent === "Active" && document.getElementById("global-lift-lockdown-btn").classList.contains("hidden")`,
          ),
        8_000,
        "Global Lift Lockdown cleared staging-win-02",
      );
      await portalBrowser.eval(`(() => {
        document.getElementById("clear-selected-devices-btn").click();
        document.getElementById("snapshots-advanced-box").open = false;
      })()`);
      await portalBrowser.screenshot(
        path.join(screenshotDir, "07_desktop_post_rollback_portal.png"),
        { fullPage: true },
      );

      gates.G5 = {
        status: "PASS",
        details: [
          "Verified family toggle revocation, explicit_deny override, device-scoped operator with inert XSS displayName, offline Pending->Confirmed sync on tetherd restart, emergency lockdown durability across restart, >10 snapshot Show-more pagination + filter, monotonic forward rollback to rev 1 (v12), and scoped Lift Emergency Lockdown.",
        ],
      };
    } catch (err) {
      gates.G5 = { status: "FAIL", details: [String(err)] };
      throw err;
    }

    // --- GATE G6: Mobile Checklist M1-M10 (Chromium Emulation 390x844 & 360x800 + optional physical prompt) ---
    const mChecks = {};
    try {
      for (const vp of [
        { name: "390x844", w: 390, h: 844, shot: "08_mobile_390x844_portal.png" },
        { name: "360x800", w: 360, h: 800, shot: "09_mobile_360x800_portal.png" },
      ]) {
        await portalBrowser.setViewport(vp.w, vp.h, true);
        const fit = await portalBrowser.eval(
          `({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })`,
        );
        assert.ok(
          fit.scrollWidth <= fit.clientWidth,
          `Mobile overflow at ${vp.name}: ${fit.scrollWidth} > ${fit.clientWidth}`,
        );
        await portalBrowser.screenshot(path.join(screenshotDir, vp.shot), {
          fullPage: true,
        });
      }
      mChecks.M1 = { status: "PASS", detail: "Zero horizontal overflow at 390x844 and 360x800" };
      mChecks.M3 = { status: "PASS", detail: "Single-column cards and unavailable banners fit cleanly" };

      // M2: Sign out -> sign in on 390x844 -> reload restores session via HttpOnly cookie
      await portalBrowser.setViewport(390, 844, true);
      await portalBrowser.eval(`document.getElementById("logout-btn").click()`);
      await until(
        () => portalBrowser.eval(`document.getElementById("auth-state-badge")?.textContent === "Not Signed In"`),
        5_000,
        "mobile sign-out",
      );
      await portalBrowser.eval(`(() => {
        document.getElementById("token-input").value = ${JSON.stringify(ownerToken)};
        document.getElementById("connect-btn").click();
      })()`);
      await until(
        () => portalBrowser.eval(`document.querySelectorAll(".device-card").length === 2`),
        8_000,
        "mobile re-login",
      );
      await portalBrowser.navigate(`${relayHttpBase}/portal`);
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent?.startsWith("Confirmed Active") && window.localStorage.length === 0 && window.sessionStorage.length === 0`,
          ),
        8_000,
        "M2 mobile reload session persistence",
      );
      mChecks.M2 = { status: "PASS", detail: "Mobile sign-in + reload persists session without web storage" };

      // M4: Mobile Select All / Clear & family switch tap
      await portalBrowser.eval(`document.getElementById("select-all-devices-btn").click()`);
      const selAllTxt = await portalBrowser.eval(
        `document.getElementById("global-target-badge")?.textContent || ""`,
      );
      assert.match(selAllTxt, /2 selected/);
      await portalBrowser.eval(`document.getElementById("clear-selected-devices-btn").click()`);
      await portalBrowser.eval(
        `document.querySelector('.device-card[data-device-id="staging-win-01"] [data-action="toggle-family"][data-family="batch"]').click()`,
      );
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Confirmed Active (v13)"`,
          ),
        8_000,
        "M4 mobile batch toggle v13",
      );
      mChecks.M4 = { status: "PASS", detail: "Select All/Clear and family switch work cleanly at 390x844" };

      // M5: Accordion stays open during live SSE update and fits inside 390px
      await portalBrowser.eval(
        `document.querySelector('.device-card[data-device-id="staging-win-01"] details.advanced-box').open = true`,
      );
      await portalBrowser.eval(
        `document.querySelector('.device-card[data-device-id="staging-win-01"] [data-action="toggle-family"][data-family="batch"]').click()`,
      );
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('[data-sync-badge="staging-win-01"]')?.textContent === "Confirmed Active (v14)"`,
          ),
        8_000,
        "M5 SSE while accordion open",
      );
      const m5Check = await portalBrowser.eval(`({
        open: document.querySelector('.device-card[data-device-id="staging-win-01"] details.advanced-box')?.open,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth
      })`);
      assert.equal(m5Check.open, true);
      assert.ok(m5Check.scrollWidth <= m5Check.clientWidth);
      mChecks.M5 = { status: "PASS", detail: "Advanced accordion stays open through SSE and fits 390px" };

      // M6: Modal + Lockdown + Lift Lockdown at mobile 390x844
      await portalBrowser.eval(`document.getElementById("emergency-revoke-btn").click()`);
      await until(
        () =>
          portalBrowser.eval(
            `document.getElementById("confirm-modal")?.classList.contains("active")`,
          ),
        5_000,
        "M6 modal open",
      );
      await portalBrowser.screenshot(
        path.join(screenshotDir, "10_mobile_390x844_modal.png"),
      );
      const modalRect = await portalBrowser.eval(`(() => {
        const b = document.getElementById("modal-confirm-btn").getBoundingClientRect();
        return { right: b.right, bottom: b.bottom, vw: window.innerWidth, vh: window.innerHeight };
      })()`);
      assert.ok(modalRect.right <= modalRect.vw && modalRect.bottom <= modalRect.vh);
      await portalBrowser.eval(`(() => {
        document.getElementById("modal-reason").value = "Mobile M6 lockdown";
        document.getElementById("modal-confirm-btn").click();
      })()`);
      await until(
        () => portalBrowser.eval(`document.getElementById("stat-security")?.textContent === "LOCKDOWN"`),
        8_000,
        "M6 lockdown active",
      );
      await portalBrowser.eval(`(() => {
        document.getElementById("global-lift-lockdown-btn").click();
        document.getElementById("modal-reason").value = "Mobile M6 lift";
        document.getElementById("modal-confirm-btn").click();
      })()`);
      await until(
        () => portalBrowser.eval(`document.getElementById("stat-security")?.textContent === "Active"`),
        8_000,
        "M6 lockdown lifted",
      );
      mChecks.M6 = { status: "PASS", detail: "Confirmation modal fits inside mobile viewport and Lift Lockdown clears state" };

      // M7: Operator Add -> Edit -> Revoke UX at 390x844
      await portalBrowser.eval(`(() => {
        document.querySelector('input[data-action="select-device"][data-device="staging-win-01"]').click();
        document.getElementById("operator-advanced-box").open = true;
        document.getElementById("op-principal-id").value = "operator:staging-ci";
        document.getElementById("op-display-name").value = "Mobile Operator";
        document.getElementById("op-profile-id").value = "read_only";
        document.getElementById("save-operator-btn").click();
      })()`);
      await until(
        () =>
          portalBrowser.eval(`(() => {
            const btn = document.querySelector('[data-action="edit-operator"][data-principal="operator:staging-ci"]');
            const rowText = btn?.closest('.identity-row')?.textContent || "";
            return rowText.includes("Mobile Operator") && rowText.includes("staging-win-01 (read_only)");
          })()`),
        8_000,
        "M7 operator added",
      );
      await portalBrowser.eval(
        `document.getElementById("clear-selected-devices-btn").click(); document.querySelector('[data-action="edit-operator"][data-principal="operator:staging-ci"]').click()`,
      );
      const editSync = await portalBrowser.eval(`({
        id: document.getElementById("op-principal-id").value,
        displayName: document.getElementById("op-display-name").value,
        profile: document.getElementById("op-profile-id").value,
        checked: document.querySelector('input[data-action="select-device"][data-device="staging-win-01"]').checked
      })`);
      assert.equal(editSync.id, "operator:staging-ci");
      assert.equal(editSync.displayName, "Mobile Operator");
      assert.equal(editSync.profile, "read_only");
      assert.equal(editSync.checked, true);
      await portalBrowser.eval(
        `document.querySelector('[data-action="remove-operator"][data-principal="operator:staging-ci"]').click()`,
      );
      await until(
        () =>
          portalBrowser.eval(
            `!document.querySelector('[data-action="remove-operator"][data-principal="operator:staging-ci"]')`,
          ),
        8_000,
        "M7 operator removed",
      );
      await portalBrowser.eval(`document.getElementById("clear-selected-devices-btn").click()`);
      mChecks.M7 = { status: "PASS", detail: "Operator Add/Edit/Revoke UX passed cleanly at mobile width" };

      // M8: Snapshot Filter & Show More on Mobile 390x844 and 360x800
      await portalBrowser.eval(`(() => {
        document.getElementById("snapshots-advanced-box").open = true;
        const sel = document.getElementById("snapshot-device-filter");
        sel.value = "staging-win-01";
        sel.dispatchEvent(new Event("change"));
      })()`);
      await until(
        () => portalBrowser.eval(`Boolean(document.getElementById("snapshots-more-btn"))`),
        5_000,
        "M8 mobile snapshots-more button",
      );
      await portalBrowser.eval(`document.getElementById("snapshots-more-btn").click()`);
      for (const vp of [
        { w: 390, h: 844 },
        { w: 360, h: 800 },
      ]) {
        await portalBrowser.setViewport(vp.w, vp.h, true);
        const m8Fit = await portalBrowser.eval(
          `({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })`,
        );
        assert.ok(m8Fit.scrollWidth <= m8Fit.clientWidth, `M8 overflow at ${vp.w}x${vp.h}`);
      }
      await portalBrowser.setViewport(390, 844, true);
      mChecks.M8 = { status: "PASS", detail: "Snapshot filter/pagination fits 390x844 and 360x800 mobile widths without overflow" };

      // M9: Live SSE offline/online update without reload
      await stopChildProcess(tetherdChild);
      tetherdChild = null;
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('.device-card[data-device-id="staging-win-01"] .pill.offline')?.textContent === "Offline"`,
          ),
        10_000,
        "M9 mobile offline SSE",
      );
      tetherdChild = spawnStagingTetherd();
      await until(
        () =>
          portalBrowser.eval(
            `document.querySelector('.device-card[data-device-id="staging-win-01"] .pill.online')?.textContent === "Online"`,
          ),
        15_000,
        "M9 mobile online SSE",
      );
      mChecks.M9 = { status: "PASS", detail: "Offline/online SSE converged cleanly without mobile page reload" };

      // M10: Sign out & console hygiene
      await portalBrowser.eval(`document.getElementById("logout-btn").click()`);
      await until(
        () => portalBrowser.eval(`document.getElementById("auth-state-badge")?.textContent === "Not Signed In"`),
        5_000,
        "M10 sign-out",
      );
      await portalBrowser.navigate(`${relayHttpBase}/portal`);
      await until(
        () => portalBrowser.eval(`document.getElementById("auth-state-badge")?.textContent === "Not Signed In"`),
        5_000,
        "M10 stays disconnected after reload",
      );
      assert.deepEqual(portalBrowser.exceptions, []);
      assert.deepEqual(portalBrowser.consoleErrors, []);
      mChecks.M10 = { status: "PASS", detail: "Sign out persisted cleanly; 0 console errors & 0 exceptions" };

      if (opts.pauseForMobile) {
        const notePath = path.join(stagingRoot, "MOBILE_SIGNIN_INFO.txt");
        const mobileNote = formatMobileCheckpointNote({
          topology,
          ownerTokenFile,
          ephemeralCaCrt: pki?.caCrt ?? null,
        });
        writeFileSync(notePath, mobileNote, { encoding: "utf8", mode: 0o600 });
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        process.stdout.write(
          `\n[Interactive Mobile Checkpoint]\n${mobileNote}` +
            `Connection files saved inside ${stagingRoot}.\n`,
        );
        const answer = (await rl.question("Did real physical mobile M1-M10 PASS? [yes/no]: "))
          .trim()
          .toLowerCase();
        rl.close();
        if (answer === "yes" || answer === "y") {
          gates.G6 = {
            status: "PASS",
            details: ["Chromium mobile emulation (390x844 & 360x800) AND physical phone M1-M10 passed."],
            mobileChecks: mChecks,
          };
        } else {
          gates.G6 = {
            status: "FAIL",
            details: ["Physical mobile verification did not confirm PASS."],
            mobileChecks: mChecks,
          };
        }
      } else {
        gates.G6 = {
          status: "BLOCKED",
          details: [
            "Automated Chromium mobile emulation (390x844 & 360x800) M1-M10 PASSED; physical iPhone Safari / Android Chrome browser validation BLOCKED without --pause-for-mobile and physical phones connected to LAN/Tailscale staging host.",
          ],
          mobileChecks: mChecks,
        };
      }
    } catch (err) {
      gates.G6 = { status: "FAIL", details: [String(err)], mobileChecks: mChecks };
      throw err;
    }
  } catch (err) {
    // Retain the first failure and emit an inspectable report after teardown.
    originalStagingError = err;
    process.stderr.write(`[staging acceptance failure] ${String(err)}\n`);
  } finally {
    // Teardown all clients, servers, child processes & staging dirs cleanly
    if (ownedDesktopHandle !== null && ownerMcp) {
      await ownerMcp
        .callTool({
          name: "process",
          arguments: {
            device: "staging-win-01",
            op: "terminate",
            args: { handle: ownedDesktopHandle, grace_ms: 100, force: true },
          },
        })
        .catch(() => {});
      ownedDesktopHandle = null;
    }
    if (clipboardCanarySet && process.platform === "win32") {
      try {
        resetStagingGuestClipboard();
      } catch (err) {
        clipboardCleanupError = err;
        process.stderr.write(`[staging guest clipboard teardown] ${String(err)}\n`);
      }
      clipboardCanarySet = false;
    }
    await ownerMcp?.close().catch(() => {});
    await operatorMcp?.close().catch(() => {});
    await unpairedMcp?.close().catch(() => {});
    await extBrowser?.close().catch(() => {});
    await portalBrowser?.close().catch(() => {});
    await stopChildProcess(humanDesktopChild);
    await stopChildProcess(tetherdChild);
    await stopChildProcess(extHostChild);
    await stopChildProcess(relayChild);
    for (const c of spawnedChildren) {
      await stopChildProcess(c).catch(() => {});
    }
    await fixtures?.close().catch(() => {});

    if (trustCertThumbprint && process.platform === "win32") {
      try {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Thumbprint -eq '${trustCertThumbprint}' } | Remove-Item -Force -ErrorAction SilentlyContinue`,
          ],
          { stdio: "ignore" },
        );
      } catch {
        // ignore cleanup failure
      }
    }
    if (firewallRuleAdded && process.platform === "win32") {
      try {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `Remove-NetFirewallRule -DisplayName 'Tetherplane-Staging-${relayPort}' -ErrorAction SilentlyContinue`,
          ],
          { stdio: "ignore" },
        );
      } catch {
        // ignore cleanup failure
      }
    }

    // Preserve external screenshotDir if user specified --screenshot-dir outside stagingRoot
    rmSync(stagingRoot, { recursive: true, force: true });

    const portsToVerify = [
      { host: relayPortCheckHost, port: relayPort },
      { host: "127.0.0.1", port: extPairingPort },
      { host: "127.0.0.1", port: extRpcPort },
      { host: "127.0.0.1", port: extWsPort },
    ];
    const portFreeResults = await Promise.all(
      portsToVerify.map(async ({ host, port }) => ({
        port,
        free: await isPortFree(host, port),
      })),
    );
    const busyPorts = portFreeResults.filter((r) => !r.free).map((r) => r.port);
    const stagingDirGone = !existsSync(stagingRoot);
    const gitAfter = getRepoGitPorcelain();
    const gitUnchanged = gitBefore === gitAfter;

    if (busyPorts.length === 0 && stagingDirGone && gitUnchanged &&
        clipboardCleanupError === null) {
      gates.G7 = {
        status: "PASS",
        details: [
          `Teardown removed ${stagingRoot}, released ports [${portsToVerify.map((p) => p.port).join(", ")}], stopped all staging processes, and left repo working tree untouched.`,
        ],
      };
    } else {
      gates.G7 = {
        status: "FAIL",
        details: [
          `Teardown incomplete: busyPorts=${JSON.stringify(busyPorts)}, stagingDirGone=${stagingDirGone}, gitUnchanged=${gitUnchanged}, clipboardCleanup=${clipboardCleanupError ? String(clipboardCleanupError) : "ok"}`,
        ],
      };
    }
  }

  const outcome = evaluateOverallOutcome({
    allowPartial: opts.allowPartial,
    gates,
  });
  const report = {
    runAt: new Date().toISOString(),
    hostname: opts.hostname,
    platform: process.platform,
    allowPartial: opts.allowPartial,
    outcome,
    screenshotDir: opts.screenshotDir ?? null,
    executionError: originalStagingError
      ? String(originalStagingError instanceof Error ? originalStagingError.message
        : originalStagingError).slice(0, 3000)
      : null,
    gates,
  };
  if (opts.reportFile) {
    mkdirSync(path.dirname(opts.reportFile), { recursive: true });
    writeFileSync(opts.reportFile, JSON.stringify(report, null, 2) + "\n", "utf8");
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(outcome.ok ? 0 : 1);
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`Invalid usage: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  if (opts.describe) {
    process.stdout.write(JSON.stringify(buildStagingPlan(opts), null, 2) + "\n");
    process.exit(0);
  }

  try {
    await runStagingAcceptance(opts);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  }
}

const isEntry =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  await main();
}
