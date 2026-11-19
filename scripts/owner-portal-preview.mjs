#!/usr/bin/env node
/**
 * Isolated local synthetic preview for the Tetherplane Owner Control Panel.
 *
 * Uses ephemeral temporary state, synthetic test identities, and four simulated
 * devices over loopback-only HTTP/WS. Never contacts production hosts, live
 * relays, OAuth/DCR issuers, or real paired devices.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import {
  ALL_TOOL_FAMILIES,
  CANONICAL_OPERATIONS_BY_FAMILY,
  RelayServer,
  StaticClientAuthenticator,
  hashDeviceCredential,
} from "../relay/dist/index.js";

const requireFromRelay = createRequire(
  new URL("../relay/package.json", import.meta.url),
);
const { WebSocket } = requireFromRelay("ws");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function parseArgs(argv) {
  const opts = {
    host: "127.0.0.1",
    port: Number(process.env.PORT ?? "4788"),
    ownerToken: process.env.TETHERPLANE_PREVIEW_TOKEN || "",
    ackDelayMs: 400,
    slowAckDelayMs: 2000,
    stateDir: "",
    jsonReady: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--host" && next) {
      opts.host = next;
      i += 1;
    } else if (arg === "--port" && next) {
      opts.port = Number(next);
      i += 1;
    } else if (arg === "--owner-token" && next) {
      opts.ownerToken = next;
      i += 1;
    } else if (arg === "--ack-delay-ms" && next) {
      opts.ackDelayMs = Math.max(0, Number(next));
      i += 1;
    } else if (arg === "--slow-ack-ms" && next) {
      opts.slowAckDelayMs = Math.max(0, Number(next));
      i += 1;
    } else if (arg === "--state-dir" && next) {
      opts.stateDir = next;
      i += 1;
    } else if (arg === "--json-ready") {
      opts.jsonReady = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: node scripts/owner-portal-preview.mjs [options]",
          "",
          "Options:",
          "  --port <num>          Loopback port (default: 4788, or 0 for ephemeral)",
          "  --host <addr>         Loopback host only: 127.0.0.1, localhost, ::1",
          "  --owner-token <tok>   Custom ephemeral preview token (default: random)",
          "  --ack-delay-ms <ms>   Simulated device ACK delay for fast devices (default: 400)",
          "  --slow-ack-ms <ms>    Simulated device ACK delay for Synth-GPU (default: 2000)",
          "  --state-dir <path>    Persist synthetic state at path instead of temp dir",
          "  --json-ready          Emit single-line JSON readiness payload on stdout",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }
  if (!LOOPBACK_HOSTS.has(opts.host)) {
    throw new Error(
      `Refusing non-loopback host '${opts.host}'. Synthetic preview is restricted to loopback (${[...LOOPBACK_HOSTS].join(", ")}).`,
    );
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error(`Invalid port: ${opts.port}`);
  }
  return opts;
}

function buildCapabilities({ browserUnavailableReason = null } = {}) {
  const providers = [
    {
      namespace: "device",
      tool_family: "device",
      available: true,
      status: "ready",
      available_operations: CANONICAL_OPERATIONS_BY_FAMILY.device,
    },
    {
      namespace: "filesystem",
      tool_family: "files",
      available: true,
      status: "ready",
      available_operations: CANONICAL_OPERATIONS_BY_FAMILY.files,
    },
    {
      namespace: "process",
      tool_family: "process",
      available: true,
      status: "ready",
      available_operations: CANONICAL_OPERATIONS_BY_FAMILY.process,
    },
    browserUnavailableReason
      ? {
          namespace: "browser",
          tool_family: "browser",
          available: false,
          status: "standby",
          unavailable_reason: browserUnavailableReason,
          available_operations: [],
        }
      : {
          namespace: "browser",
          tool_family: "browser",
          available: true,
          status: "ready",
          available_operations: CANONICAL_OPERATIONS_BY_FAMILY.browser,
        },
    {
      namespace: "desktop",
      tool_family: "desktop",
      available: true,
      status: "ready",
      available_operations: CANONICAL_OPERATIONS_BY_FAMILY.desktop,
    },
    {
      namespace: "batch",
      tool_family: "batch",
      available: true,
      status: "ready",
      available_operations: CANONICAL_OPERATIONS_BY_FAMILY.batch,
    },
  ];

  const toolFamilies = {};
  for (const family of ALL_TOOL_FAMILIES) {
    const unavailable = family === "browser" && Boolean(browserUnavailableReason);
    toolFamilies[family] = {
      available: !unavailable,
      provider_available: !unavailable,
      ...(unavailable ? { unavailable_reason: browserUnavailableReason } : {}),
      available_operations: unavailable
        ? []
        : [...CANONICAL_OPERATIONS_BY_FAMILY[family]],
    };
  }

  return { providers, tool_families: toolFamilies };
}

async function apiJson(baseUrl, pathname, token, method = "GET", body) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(
      `Preview seed ${method} ${pathname} failed (${res.status}): ${JSON.stringify(data)}`,
    );
  }
  return data;
}

async function pairSyntheticDevice(baseUrl, ownerToken, deviceId) {
  const secret = `synth-secret-${deviceId}-${randomBytes(16).toString("hex")}`;
  const start = await apiJson(baseUrl, "/pair/start", null, "POST", {
    deviceId,
    credentialHash: hashDeviceCredential(secret),
  });
  await apiJson(baseUrl, "/pair/approve", ownerToken, "POST", {
    userCode: start.userCode,
  });
  return secret;
}

async function connectSyntheticDevice({
  deviceWsUrl,
  deviceId,
  secret,
  status,
  capabilities,
  initialAppliedRevision,
  ackDelayMs,
  autoAckRef,
}) {
  const socket = new WebSocket(deviceWsUrl, {
    headers: {
      authorization: `Device ${secret}`,
      "x-tetherplane-device-id": deviceId,
    },
  });

  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const timers = new Set();
  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === "policy_sync" && msg.policy) {
      const revision = Number(msg.policy.revision);
      const delay = autoAckRef.immediate ? 15 : ackDelayMs;
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(
          JSON.stringify({
            type: "policy_ack",
            deviceId,
            revision,
            currentRevision: revision,
            applied: true,
            appliedAtMs: Date.now(),
            status,
            capabilities,
          }),
        );
      }, delay);
      timers.add(timer);
    }
  });

  socket.send(
    JSON.stringify({
      type: "device_hello",
      deviceId,
      appliedPolicyRevision: initialAppliedRevision,
      status,
      capabilities,
    }),
  );

  return {
    deviceId,
    close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      try {
        socket.close();
      } catch {
        // ignore close error
      }
    },
  };
}

async function waitForConfirmed(baseUrl, ownerToken, deviceId, expectedRev) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const overview = await apiJson(baseUrl, "/portal/api/overview", ownerToken);
    const dev = overview.devices.find((d) => d.deviceId === deviceId);
    if (
      dev &&
      dev.online &&
      dev.confirmedByDevice &&
      Number(dev.appliedRevision) === expectedRev
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for synthetic device ${deviceId} v${expectedRev} confirmation`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ownerToken =
    opts.ownerToken || `tether-preview-${randomBytes(16).toString("hex")}`;
  const ephemeralDir = !opts.stateDir;
  const stateDir =
    opts.stateDir ||
    (await mkdtemp(path.join(os.tmpdir(), "tetherplane-owner-portal-preview-")));

  const relay = await RelayServer.create({
    authenticator: new StaticClientAuthenticator([
      {
        token: ownerToken,
        accountId: "acct-preview",
        clientId: "preview-owner-portal",
        principalId: "human:owner-preview",
        role: "owner",
      },
      {
        token: `synth-op-coding-${randomBytes(12).toString("hex")}`,
        accountId: "acct-preview",
        clientId: "preview-coding-assistant",
        principalId: "operator:coding-assistant",
        role: "operator",
      },
      {
        token: `synth-op-auditor-${randomBytes(12).toString("hex")}`,
        accountId: "acct-preview",
        clientId: "preview-readonly-auditor",
        principalId: "operator:readonly-auditor",
        role: "operator",
      },
    ]),
    stateFile: path.join(stateDir, "devices.json"),
    allowInsecureLocalhost: true,
  });

  const address = await relay.listen({ host: opts.host, port: opts.port });
  const sockets = [];
  const autoAckRef = { immediate: true };

  // 1. Pair 4 synthetic devices matching the authenticated 4-device architecture
  const workstationSecret = await pairSyntheticDevice(
    address.httpUrl,
    ownerToken,
    "Synth-Workstation",
  );
  const laptopSecret = await pairSyntheticDevice(
    address.httpUrl,
    ownerToken,
    "Synth-Laptop",
  );
  const gpuSecret = await pairSyntheticDevice(
    address.httpUrl,
    ownerToken,
    "Synth-GPU",
  );
  await pairSyntheticDevice(address.httpUrl, ownerToken, "Synth-Tablet");

  // 2. Connect 3 online synthetic devices (Synth-Tablet remains offline)
  sockets.push(
    await connectSyntheticDevice({
      deviceWsUrl: address.deviceWsUrl,
      deviceId: "Synth-Workstation",
      secret: workstationSecret,
      status: {
        os: "windows",
        arch: "x86_64",
        agent_version: "0.1.0",
        policy_mode: "background_only",
      },
      capabilities: buildCapabilities(),
      initialAppliedRevision: 1,
      ackDelayMs: opts.ackDelayMs,
      autoAckRef,
    }),
  );
  sockets.push(
    await connectSyntheticDevice({
      deviceWsUrl: address.deviceWsUrl,
      deviceId: "Synth-Laptop",
      secret: laptopSecret,
      status: {
        os: "macos",
        arch: "arm64",
        agent_version: "0.1.0",
        policy_mode: "background_only",
      },
      capabilities: buildCapabilities({
        browserUnavailableReason:
          "Chrome extension not connected — browser provider in standby",
      }),
      initialAppliedRevision: 1,
      ackDelayMs: opts.ackDelayMs + 200,
      autoAckRef,
    }),
  );
  sockets.push(
    await connectSyntheticDevice({
      deviceWsUrl: address.deviceWsUrl,
      deviceId: "Synth-GPU",
      secret: gpuSecret,
      status: {
        os: "linux",
        arch: "x86_64",
        agent_version: "0.1.0",
        policy_mode: "background_only",
      },
      capabilities: buildCapabilities(),
      initialAppliedRevision: 1,
      ackDelayMs: opts.slowAckDelayMs,
      autoAckRef,
    }),
  );

  // 3. Seed realistic daily state (explicit deny, read-only profile, scoped operators, offline queued update)
  await apiJson(
    address.httpUrl,
    "/portal/api/devices/Synth-Workstation/policy",
    ownerToken,
    "POST",
    {
      revokeCapabilities: ["desktop.physical_pointer_move"],
      reason: "Block physical pointer move during daytime work",
    },
  );
  await waitForConfirmed(address.httpUrl, ownerToken, "Synth-Workstation", 2);

  await apiJson(
    address.httpUrl,
    "/portal/api/devices/Synth-GPU/policy",
    ownerToken,
    "POST",
    {
      profileId: "read_only",
      reason: "Keep GPU node read-only during model training",
    },
  );
  await waitForConfirmed(address.httpUrl, ownerToken, "Synth-GPU", 2);

  await apiJson(address.httpUrl, "/portal/api/operators", ownerToken, "POST", {
    principalId: "operator:coding-assistant",
    displayName: "Coding Assistant",
    profileId: "standard",
    deviceIds: ["Synth-Workstation", "Synth-Laptop"],
    reason: "Scoped daily coding helper on workstation and laptop",
  });
  await waitForConfirmed(address.httpUrl, ownerToken, "Synth-Workstation", 3);
  await waitForConfirmed(address.httpUrl, ownerToken, "Synth-Laptop", 2);

  await apiJson(address.httpUrl, "/portal/api/operators", ownerToken, "POST", {
    principalId: "operator:readonly-auditor",
    displayName: "Read-Only Auditor",
    profileId: "read_only",
    deviceIds: ["Synth-Workstation"],
    reason: "Allow non-destructive inspection on workstation",
  });
  await waitForConfirmed(address.httpUrl, ownerToken, "Synth-Workstation", 4);

  // Queue an offline change on Synth-Tablet so offline Pending Device Ack is immediately visible
  await apiJson(
    address.httpUrl,
    "/portal/api/devices/Synth-Tablet/policy",
    ownerToken,
    "POST",
    {
      revokeFamilies: ["process"],
      reason: "Disable process execution while tablet is traveling offline",
    },
  );

  // Switch synthetic devices to realistic ACK delays for live interactive testing
  autoAckRef.immediate = false;

  const portalUrl = `${address.httpUrl}/portal`;
  if (opts.jsonReady) {
    process.stdout.write(
      `${JSON.stringify({
        ready: true,
        portalUrl,
        httpUrl: address.httpUrl,
        ownerToken,
        ownerPrincipalId: "human:owner-preview",
        stateDir,
        devices: [
          "Synth-Workstation",
          "Synth-Laptop",
          "Synth-GPU",
          "Synth-Tablet",
        ],
      })}\n`,
    );
  } else {
    process.stdout.write(
      [
        "",
        "====================================================================",
        "  Tetherplane Owner Control Panel — Isolated Synthetic Preview",
        "====================================================================",
        `  Portal URL:        ${portalUrl}`,
        `  Owner Identity:    human:owner-preview (ephemeral test identity)`,
        `  Owner Token:       ${ownerToken}`,
        `  State Directory:   ${stateDir}${ephemeralDir ? " (ephemeral)" : ""}`,
        "  Synthetic Fleet:   Synth-Workstation (online, healthy, fast ACK)",
        "                     Synth-Laptop      (online, browser standby)",
        "                     Synth-GPU         (online, read-only, 2s ACK to observe Pending -> Confirmed)",
        "                     Synth-Tablet      (offline, queued pending rev 2)",
        "",
        "  Safety: Loopback-only synthetic relay. No real devices or prod auth.",
        "  Press Ctrl+C to stop and clean up ephemeral preview state.",
        "====================================================================",
        "",
      ].join("\n"),
    );
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    for (const sock of sockets) sock.close();
    await relay.close().catch(() => {});
    if (ephemeralDir) {
      await rm(stateDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }).catch(() => {});
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  process.stderr.write(`Preview server error: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
