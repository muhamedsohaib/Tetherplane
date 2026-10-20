#!/usr/bin/env node
// Tests only an isolated candidate binary and disposable fixtures, not services.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function parseArguments(argv) {
  if (argv.length !== 4 ||
    argv[0] !== "--tetherd" || argv[2] !== "--scratch-parent") {
    throw new Error("Usage: --tetherd <binary> --scratch-parent <temporary-directory>");
  }
  return { binary: argv[1], scratchParent: argv[3] };
}

function request(capability, args = {}) {
  return {
    protocol_version: "1.0",
    request_id: randomUUID(),
    device_id: "Leno",
    capability,
    arguments: args,
    actor: { id: "installed-copy-canary", kind: "ai_client" },
    session_id: null,
    response_mode: "compact",
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
}

function invoke(binary, workspace, profile, query) {
  const args = ["--stdio-rpc", "--allow", workspace];
  if (profile) args.push("--principal-profile", profile);
  const result = spawnSync(binary, args, {
    cwd: workspace,
    input: JSON.stringify(query) + "\n",
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "candidate agent exited unsuccessfully");
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, "expected one JSONL response");
  const reply = JSON.parse(lines[0]);
  assert.equal(reply.request_id, query.request_id);
  return reply;
}

function denied(reply, code) {
  assert.equal(reply.status, "error", "unauthorized operation was allowed");
  assert.equal(reply.error?.code, code, "unexpected authorization failure");
}

function hasCopy(reply) {
  assert.equal(reply.status, "success");
  const entry = reply.data.providers.find((item) => item.namespace === "filesystem");
  assert.ok(entry, "filesystem capability missing");
  return entry.operations.includes("copy");
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { binary, scratchParent } = parseArguments(process.argv.slice(2));
assert.ok(fs.statSync(binary).isFile(), "installed candidate binary missing");
fs.mkdirSync(scratchParent, { recursive: true });
const ownedRoot = fs.mkdtempSync(path.join(scratchParent, "copy-canary-"));

try {
  const workspace = path.join(ownedRoot, "workspace");
  const outside = path.join(ownedRoot, "outside");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  const source = path.join(workspace, "source.bin");
  const destination = path.join(workspace, "destination.bin");
  const external = path.join(outside, "external.bin");
  const deniedDestination = path.join(workspace, "denied.bin");
  const externalDestination = path.join(outside, "denied.bin");

  const bytes = Buffer.alloc(8192);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 53 + 31) & 255;
  fs.writeFileSync(source, bytes);
  fs.writeFileSync(external, Buffer.from([13, 0, 250, 1, 255]));

  const principal = path.join(ownedRoot, "principal.json");
  const setPrincipal = (granted) => fs.writeFileSync(principal, JSON.stringify({
    principal_id: "operator:windows-copy-canary",
    authentication: "local_process_binding",
    allowed_devices: ["Leno"],
    allowed_capabilities: granted
      ? ["device.capabilities", "filesystem.copy", "filesystem.read"]
      : ["device.capabilities", "filesystem.read"],
    allowed_directories: [workspace],
  }));

  assert.equal(hasCopy(invoke(binary, workspace, null, request("device.capabilities"))), false);
  denied(invoke(binary, workspace, null,
    request("filesystem.copy", { source, destination })), "permission_denied");
  assert.equal(fs.existsSync(destination), false);

  setPrincipal(false);
  assert.equal(hasCopy(invoke(binary, workspace, principal, request("device.capabilities"))), false);
  denied(invoke(binary, workspace, principal,
    request("filesystem.copy", { source, destination })), "permission_denied");
  assert.equal(fs.existsSync(destination), false);

  setPrincipal(true);
  assert.equal(hasCopy(invoke(binary, workspace, principal, request("device.capabilities"))), true);
  const copied = invoke(binary, workspace, principal, request("filesystem.copy", { source, destination }));
  assert.equal(copied.status, "success");
  assert.equal(copied.data.bytes, bytes.length);
  assert.equal(copied.data.replaced, false);
  assert.equal(hash(fs.readFileSync(source)), hash(bytes));
  assert.equal(hash(fs.readFileSync(destination)), hash(bytes));

  denied(invoke(binary, workspace, principal,
    request("filesystem.copy", { source, destination })), "precondition_failed");
  assert.equal(hash(fs.readFileSync(destination)), hash(bytes));

  denied(invoke(binary, workspace, principal, request("filesystem.copy", {
    source: external, destination: deniedDestination,
  })), "permission_denied");
  denied(invoke(binary, workspace, principal, request("filesystem.copy", {
    source, destination: externalDestination,
  })), "permission_denied");
  assert.equal(fs.existsSync(deniedDestination), false);
  assert.equal(fs.existsSync(externalDestination), false);
  assert.equal(fs.readFileSync(external).length, 5);

  process.stdout.write(JSON.stringify({
    status: "PASS_INSTALLED_AGENT_COPY_CANARY",
    bytes: bytes.length,
    sha256: hash(bytes),
    unbound_denied: true,
    ungranted_denied: true,
    binary_copy_pass: true,
    overwrite_denied: true,
    outside_source_denied: true,
    outside_destination_denied: true,
    services_touched: false,
  }) + "\n");
} finally {
  // Remove only the randomly created child, never its parent.
  fs.rmSync(ownedRoot, { recursive: true, force: true });
}
