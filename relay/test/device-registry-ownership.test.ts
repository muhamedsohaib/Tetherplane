import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DeviceRegistry, hashDeviceCredential } from "../src/devices/registry.ts";
import { RelayServer } from "../src/server.ts";
import { StaticClientAuthenticator } from "../src/auth/static-auth.ts";

async function close(registry: DeviceRegistry | undefined) {
  const fn = (registry as unknown as { close?: () => Promise<void> } | undefined)?.close;
  if (fn) await fn.call(registry);
}
async function childOpen(stateFile: string, crash = false) {
  const source = "import { DeviceRegistry } from " + JSON.stringify(new URL("../src/devices/registry.ts", import.meta.url).href) + ";\n" +
    "try { const registry = await DeviceRegistry.open({ stateFile: " + JSON.stringify(stateFile) + " }); " +
    (crash ? "process.stdout.write('owned'); process.exit(23);" : "process.stdout.write('opened'); if(registry.close) await registry.close();") +
    " } catch { process.stdout.write('denied'); process.exitCode=7; }";
  const child = spawn(process.execPath, ["--input-type=module", "-e", source],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  const [code] = await once(child, "exit");
  return { code, output };
}

test("one state file has one live registry owner, even through a canonical path alias", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tp-registry-owner-"));
  let owner: DeviceRegistry | undefined, contender: DeviceRegistry | undefined;
  try {
    const real = path.join(temp, "state");
    const stateFile = path.join(real, "devices.json");
    owner = await DeviceRegistry.open({ stateFile });
    // Baseline open did not create its parent, so prepare the alias directory.
    await import("node:fs/promises").then(({ mkdir }) => mkdir(real, { recursive: true }));
    const alias = path.join(temp, "alias");
    await symlink(real, alias, "junction");
    await assert.rejects(async () => { contender = await DeviceRegistry.open({ stateFile: path.join(alias, "devices.json") }); }, /registry.*owned|registry.*in use/i);
    if (process.platform === "win32") {
      await assert.rejects(async () => { contender = await DeviceRegistry.open({ stateFile: stateFile.toUpperCase() }); }, /registry.*owned|registry.*in use/i);
    }
    assert.deepEqual(await childOpen(stateFile), { code: 7, output: "denied" });
  } finally { await close(contender); await close(owner); await rm(temp, { recursive: true, force: true }); }
});

test("closing drains an approved mutation before releasing ownership and rejects further use", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tp-registry-close-"));
  let owner: DeviceRegistry | undefined, reopened: DeviceRegistry | undefined;
  try {
    const stateFile = path.join(temp, "devices.json");
    owner = await DeviceRegistry.open({ stateFile });
    const secret = randomBytes(32).toString("hex");
    const started = await owner.startPairing({ deviceId: "DurableClose", credentialHash: hashDeviceCredential(secret) });
    const approving = owner.approvePairing({ accountId: "owner", userCode: started.userCode });
    const closing = close(owner);
    await Promise.all([approving, closing]);
    await assert.rejects(owner.authenticateDevice("DurableClose", secret), /closed/i);
    reopened = await DeviceRegistry.open({ stateFile });
    assert.equal(await reopened.authenticateDevice("DurableClose", secret), "owner");
    await close(owner);
  } finally { await close(owner); await close(reopened); await rm(temp, { recursive: true, force: true }); }
});

test("failed JSON load releases ownership for repair and a subsequent open", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tp-registry-load-"));
  let registry: DeviceRegistry | undefined;
  try {
    const stateFile = path.join(temp, "devices.json");
    await writeFile(stateFile, "invalid-json");
    await assert.rejects(DeviceRegistry.open({ stateFile }));
    await writeFile(stateFile, JSON.stringify({ version: 1, devices: [] }));
    registry = await DeviceRegistry.open({ stateFile });
    assert.deepEqual(registry.listDevices("owner"), []);
  } finally { await close(registry); await rm(temp, { recursive: true, force: true }); }
});

test("an abruptly exiting owner leaves no stale local lock to block restart", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tp-registry-crash-"));
  let registry: DeviceRegistry | undefined;
  try {
    const stateFile = path.join(temp, "devices.json");
    assert.deepEqual(await childOpen(stateFile, true), { code: 23, output: "owned" });
    registry = await DeviceRegistry.open({ stateFile });
    assert.deepEqual(registry.listDevices("owner"), []);
  } finally { await close(registry); await rm(temp, { recursive: true, force: true }); }
});

test("failed relay construction releases its registry and normal relay close allows restart", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "tp-relay-owner-"));
  let registry: DeviceRegistry | undefined, relay: RelayServer | undefined;
  const authenticator = new StaticClientAuthenticator([]);
  try {
    const stateFile = path.join(temp, "devices.json");
    await assert.rejects(RelayServer.create({ stateFile, authenticator, tls: { key: "invalid", cert: "invalid" } }));
    registry = await DeviceRegistry.open({ stateFile });
    await close(registry); registry = undefined;
    relay = await RelayServer.create({ stateFile, authenticator, allowInsecureLocalhost: true });
    await relay.close();
    registry = await DeviceRegistry.open({ stateFile });
  } finally { await relay?.close(); await close(registry); await rm(temp, { recursive: true, force: true }); }
});
