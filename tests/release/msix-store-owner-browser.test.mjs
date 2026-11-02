import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  validateOwnerExtensionId, assertPackagedBrowserAssets,
  readOwnerBrowserEnrollment, enrollOwnerBrowser, ownerBrowserAgentArgs
} from "../../packaging/msix-store-runtime/app/browser-owner.mjs";
import { persistApprovedConfig, createWizard } from "../../packaging/msix-store-runtime/app/runtime-app.mjs";

const fakeId = "abcdefghijklmnopabcdefghijklmnop";
const relay = "wss://relay.example.test/device";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tp-owner-browser-review-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const packageRoot = join(root, "package");
  const allowed = join(root, "approved");
  await mkdir(allowed);
  for (const file of [
    "bin/tetherd.exe", "bin/tetherplane-browserw.exe",
    "browser/host.mjs", "browser/extension/dist/background.js",
    "browser/extension/dist/pair.js"
  ]) {
    const target = join(packageRoot, ...file.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "synthetic-not-an-executable");
  }
  await writeFile(join(packageRoot, "browser/extension/manifest.json"),
    JSON.stringify({ background: { service_worker: "dist/background.js" } }));
  await persistApprovedConfig(stateRoot, {
    deviceId: "tp-owner-browser-review", relayUrl: relay, allowRoot: allowed,
    secret: "synthetic-credential-for-local-unit-test-only-20261102",
    expiresAt: Date.now() + 300000
  });
  return { root, stateRoot, packageRoot, allowed };
}

function processStub() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stderr = { resume() {} };
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0);
    return true;
  };
  return child;
}
function tokens(wizard) {
  const u = new URL(wizard.url);
  return { origin: u.origin, token: u.hash.slice(1) };
}
async function action(wizard, path, body, options = {}) {
  const { origin, token } = tokens(wizard);
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: options.origin || origin,
      "x-tetherplane-setup": options.token ?? token },
    body: JSON.stringify(body),
    redirect: "manual"
  });
  return { status: response.status, json: await response.json() };
}
test("only exact local owner Chrome extension IDs are accepted", () => {
  assert.equal(validateOwnerExtensionId(fakeId), fakeId);
  for (const value of ["", "A".repeat(32), "a".repeat(31),
    "z".repeat(32), "../evil", null, 123, "a".repeat(33)]) {
    assert.throws(() => validateOwnerExtensionId(value));
  }
  assert.deepEqual(ownerBrowserAgentArgs("C:\\private"), [
    "--browser-bridge", "127.0.0.1:17657",
    "--browser-bridge-token-file", join("C:\\private", "browser-bridge.token")
  ]);
});

test("no browser enrollment grants exist without an explicit owner action", async t => {
  const root = await mkdtemp(join(tmpdir(), "tp-no-owner-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readOwnerBrowserEnrollment(root), null);
  await assert.rejects(() => assertPackagedBrowserAssets(root));
});

test("protected enrollment is immutable and refuses partial or modified state", async t => {
  const f = await fixture(t);
  assert.equal(await readOwnerBrowserEnrollment(f.stateRoot), null);
  await assertPackagedBrowserAssets(f.packageRoot);
  const result = await enrollOwnerBrowser(f.stateRoot, f.packageRoot, fakeId);
  assert.deepEqual(result, { enrolled: true, requiresExtensionPairing: true });
  assert.deepEqual(await readOwnerBrowserEnrollment(f.stateRoot), { enrolled: true });
  const agentToken = await readFile(join(f.stateRoot, "browser-bridge.token"), "utf8");
  const pairingToken = await readFile(join(f.stateRoot, "browser-extension-launch.token"), "utf8");
  assert.ok(agentToken.trim().length >= 32);
  assert.ok(pairingToken.trim().length >= 32);
  assert.notEqual(agentToken, pairingToken);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(agentToken.trim()));
  await assert.rejects(() => enrollOwnerBrowser(f.stateRoot, f.packageRoot, fakeId));
  assert.equal(await readFile(join(f.stateRoot, "browser-bridge.token"), "utf8"), agentToken);
  await writeFile(join(f.stateRoot, "browser-extension-launch.token"), "short\n");
  await assert.rejects(() => readOwnerBrowserEnrollment(f.stateRoot),
    /needs owner review|token needs owner review/);
  assert.equal(await readFile(join(f.stateRoot, "browser-bridge.token"), "utf8"), agentToken);
});

test("foreign partial browser state cannot be enrolled over or activated", async t => {
  const f = await fixture(t);
  const pin = join(f.stateRoot, "browser-extension.id");
  await writeFile(pin, fakeId + "\\n", { flag: "wx" });
  await assert.rejects(() => readOwnerBrowserEnrollment(f.stateRoot), /Partial browser enrollment/);
  await assert.rejects(() => enrollOwnerBrowser(f.stateRoot, f.packageRoot, fakeId));
  assert.equal(await readFile(pin, "utf8"), fakeId + "\\n");
  const spawned = [];
  const wizard = await createWizard({
    stateRoot: f.stateRoot, packageRoot: f.packageRoot,
    spawnAgent: (_path, args) => { spawned.push(args); return processStub(); }
  });
  t.after(() => wizard.close());
  assert.equal(wizard.state.browserState, "needs_owner_review");
  const status = await action(wizard, "/api/start", { confirmation: "I APPROVED THIS DEVICE" });
  assert.equal(status.status, 200, "paired core must not depend on browser enrollment");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].includes("--browser-bridge"), false);
  assert.equal((await action(wizard, "/api/browser/start", {
    confirmation: "I AUTHORIZE LOCAL BROWSER HOST"
  })).status, 400);
  await action(wizard, "/api/stop", {});
});

test("missing packaged browser host leaves approved device functional but browser blocked", async t => {
  const f = await fixture(t);
  await enrollOwnerBrowser(f.stateRoot, f.packageRoot, fakeId);
  await rm(join(f.packageRoot, "browser", "host.mjs"));
  const spawned = [];
  const wizard = await createWizard({
    stateRoot: f.stateRoot, packageRoot: f.packageRoot,
    spawnAgent: (_path, args) => { spawned.push(args); return processStub(); }
  });
  t.after(() => wizard.close());
  const started = await action(wizard, "/api/start", { confirmation: "I APPROVED THIS DEVICE" });
  assert.equal(started.status, 200);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].includes("--browser-bridge"), false);
  assert.equal(wizard.state.browserState, "needs_owner_review");
  assert.equal((await action(wizard, "/api/browser/start", {
    confirmation: "I AUTHORIZE LOCAL BROWSER HOST"
  })).status, 400);
  await action(wizard, "/api/stop", {});
});

test("Store wizard requires separate device and browser owner approvals", async t => {
  const f = await fixture(t);
  const agents = [], hosts = [];
  const wizard = await createWizard({
    stateRoot: f.stateRoot, packageRoot: f.packageRoot,
    spawnAgent: (_path, args) => {
      agents.push(args);
      return processStub();
    },
    spawnBrowserHost: (path, args) => {
      hosts.push({ path, args });
      return processStub();
    }
  });
  t.after(() => wizard.close());
  const forged = await action(wizard, "/api/browser/enroll", {
    extensionId: fakeId, confirmation: "I AUTHORIZE THIS BROWSER EXTENSION"
  }, { origin: "https://not-local.example" });
  assert.equal(forged.status, 403);
  const unapproved = await action(wizard, "/api/browser/enroll", {
    extensionId: fakeId, confirmation: "yes"
  });
  assert.equal(unapproved.status, 400);
  const early = await action(wizard, "/api/browser/start", {
    confirmation: "I AUTHORIZE LOCAL BROWSER HOST"
  });
  assert.equal(early.status, 400);
  assert.equal(await readOwnerBrowserEnrollment(f.stateRoot), null);
  const firstAgent = await action(wizard, "/api/start", { confirmation: "I APPROVED THIS DEVICE" });
  assert.equal(firstAgent.status, 200);
  assert.ok(!agents[0].includes("--browser-bridge"));
  const whileRunning = await action(wizard, "/api/browser/enroll", {
    extensionId: fakeId, confirmation: "I AUTHORIZE THIS BROWSER EXTENSION"
  });
  assert.equal(whileRunning.status, 400);
  await action(wizard, "/api/stop", {});
  const enrolled = await action(wizard, "/api/browser/enroll", {
    extensionId: fakeId, confirmation: "I AUTHORIZE THIS BROWSER EXTENSION"
  });
  assert.equal(enrolled.status, 200);
  assert.deepEqual(enrolled.json, { enrolled: true, connected: "not_verified" });
  const second = await action(wizard, "/api/start", { confirmation: "I APPROVED THIS DEVICE" });
  assert.equal(second.status, 200);
  assert.ok(agents[1].includes("--browser-bridge"));
  assert.ok(agents[1].includes("127.0.0.1:17657"));
  assert.ok(agents[1].includes("--browser-bridge-token-file"));
  const unapprovedHost = await action(wizard, "/api/browser/start", { confirmation: "start" });
  assert.equal(unapprovedHost.status, 400);
  const host = await action(wizard, "/api/browser/start", {
    confirmation: "I AUTHORIZE LOCAL BROWSER HOST"
  });
  assert.equal(host.status, 200);
  assert.equal(host.json.connected, "not_verified");
  assert.equal(hosts.length, 1);
  assert.ok(hosts[0].path.endsWith("tetherplane-browserw.exe"));
  assert.deepEqual(hosts[0].args, ["--browser-state-dir", f.stateRoot]);
  const stop = await action(wizard, "/api/browser/stop", {
    confirmation: "STOP THIS BROWSER HOST"
  });
  assert.equal(stop.status, 200);
  const actualSecret = (await readFile(join(f.stateRoot, "browser-bridge.token"), "utf8")).trim();
  assert.doesNotMatch(JSON.stringify({firstAgent, enrolled, second, host, stop}),
    new RegExp(actualSecret));
  await action(wizard, "/api/stop", {});
});
