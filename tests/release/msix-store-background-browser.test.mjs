import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  persistApprovedConfig, createWizard
} from "../../packaging/msix-store-runtime/app/runtime-app.mjs";
import {
  enrollOwnerBrowser, readOwnerBrowserEnrollment,
  readOwnerBrowserBackgroundOptIn, approveOwnerBrowserBackground,
  disableOwnerBrowserBackground, OWNER_BROWSER_BACKGROUND_APPROVAL,
  OWNER_BROWSER_BACKGROUND_FILE
} from "../../packaging/msix-store-runtime/app/browser-owner.mjs";
import { launchApprovedBackgroundBrowser } from "../../packaging/msix-store-runtime/app/agent-autostart.mjs";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const credential = "synthetic-browser-background-owner-credential-20261102";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tp-store-background-review-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const stateRoot = join(root, "state");
  const packageRoot = join(root, "packaged");
  const allowRoot = join(root, "approved-directory");
  await mkdir(allowRoot);
  for (const name of [
    "bin/tetherd.exe", "bin/tetherd-agentw.exe",
    "bin/tetherplane-browserw.exe", "bin/tetherplane-autostartw.exe",
    "app/agent-autostart.mjs", "runtime/node.exe",
    "browser/host.mjs", "browser/extension/dist/background.js",
    "browser/extension/dist/pair.js"
  ]) {
    const target = join(packageRoot, ...name.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "synthetic-fixture-only");
  }
  await writeFile(join(packageRoot, "browser/extension/manifest.json"),
    JSON.stringify({ background: { service_worker: "dist/background.js" } }));
  await persistApprovedConfig(stateRoot, {
    deviceId: "tp-background-acceptance", relayUrl: "wss://synthetic.example.test/device",
    allowRoot, secret: credential, expiresAt: Date.now() + 500000
  });
  return { root, stateRoot, packageRoot };
}

function processStub() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stderr = { resume() {} };
  child.unrefCount = 0;
  child.unref = () => { child.unrefCount++; };
  child.kill = () => { child.exitCode = 0; child.emit("exit", 0); return true; };
  return child;
}
async function action(wizard, path, body, options = {}) {
  const url = new URL(wizard.url);
  const response = await fetch(url.origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tetherplane-setup": options.token ?? url.hash.slice(1),
      origin: options.origin ?? url.origin
    },
    body: JSON.stringify(body),
    redirect: "manual"
  });
  return { status: response.status, data: await response.json() };
}

test("background consent is not implied by device pairing or browser enrollment", async t => {
  const f = await fixture(t);
  assert.equal(await readOwnerBrowserBackgroundOptIn(f.stateRoot), false);
  await assert.rejects(() => approveOwnerBrowserBackground(f.stateRoot, f.packageRoot),
    /Enroll an owner-pinned extension/);
  await enrollOwnerBrowser(f.stateRoot, f.packageRoot, extensionId);
  assert.equal(await readOwnerBrowserBackgroundOptIn(f.stateRoot), false);
  const configBefore = await readFile(join(f.stateRoot, "device-credential.txt"), "utf8");
  assert.deepEqual(await approveOwnerBrowserBackground(f.stateRoot, f.packageRoot),
    { approved: true, alreadyApproved: false });
  assert.equal(await readOwnerBrowserBackgroundOptIn(f.stateRoot), true);
  assert.equal(await readFile(join(f.stateRoot, OWNER_BROWSER_BACKGROUND_FILE), "utf8"),
    OWNER_BROWSER_BACKGROUND_APPROVAL);
  assert.deepEqual(await approveOwnerBrowserBackground(f.stateRoot, f.packageRoot),
    { approved: true, alreadyApproved: true });
  assert.equal(await readFile(join(f.stateRoot, "device-credential.txt"), "utf8"),
    configBefore);
  assert.deepEqual(await disableOwnerBrowserBackground(f.stateRoot),
    { approved: false, alreadyDisabled: false });
  assert.equal(await readOwnerBrowserBackgroundOptIn(f.stateRoot), false);
  assert.deepEqual(await disableOwnerBrowserBackground(f.stateRoot),
    { approved: false, alreadyDisabled: true });
  assert.deepEqual(await readOwnerBrowserEnrollment(f.stateRoot), { enrolled: true });
});

test("background opt-in is an immutable protected marker, not a web capability grant", async t => {
  const f = await fixture(t);
  await enrollOwnerBrowser(f.stateRoot, f.packageRoot, extensionId);
  const marker = join(f.stateRoot, OWNER_BROWSER_BACKGROUND_FILE);
  await writeFile(marker, "forged\n", { flag: "wx" });
  await assert.rejects(() => readOwnerBrowserBackgroundOptIn(f.stateRoot),
    /approval needs owner review/);
  await assert.rejects(() => approveOwnerBrowserBackground(f.stateRoot, f.packageRoot));
  assert.equal(await readFile(marker, "utf8"), "forged\n",
    "no unauthorized replacement or silent permission repair");
});

test("logon supervisor launches only an opted-in owner-pinned packaged browser", async t => {
  const f = await fixture(t);
  const launches = [];
  const spawnHost = (exe, args, options) => {
    const child = processStub();
    launches.push({ exe, args, options, child });
    return child;
  };
  const options = { stateRoot: f.stateRoot, packageRoot: f.packageRoot, spawnHost };
  assert.equal(await launchApprovedBackgroundBrowser(options), null);
  await enrollOwnerBrowser(f.stateRoot, f.packageRoot, extensionId);
  assert.equal(await launchApprovedBackgroundBrowser(options), null);
  assert.equal(launches.length, 0);
  await approveOwnerBrowserBackground(f.stateRoot, f.packageRoot);
  const host = await launchApprovedBackgroundBrowser(options);
  assert.equal(host, launches[0].child);
  assert.equal(launches.length, 1);
  assert.ok(launches[0].exe.endsWith("tetherplane-browserw.exe"));
  assert.deepEqual(launches[0].args, [
    "--browser-state-dir", f.stateRoot, "--require-background-optin"
  ]);
  assert.equal(launches[0].options.windowsHide, true);
  assert.equal(launches[0].options.detached ?? false, false,
    "logon supervisor owns its host and cleans up on logoff");
  await disableOwnerBrowserBackground(f.stateRoot);
  assert.equal(await launchApprovedBackgroundBrowser(options), null);
  assert.equal(launches.length, 1);
});

test("owner handoff outlives wizard, but never bypasses a live session or re-pairs", async t => {
  const f = await fixture(t);
  const background = [];
  const agents = [];
  const wizard = await createWizard({
    stateRoot: f.stateRoot, packageRoot: f.packageRoot,
    spawnAgent: (_path, args) => {
      agents.push(args);
      return processStub();
    },
    spawnBackgroundSupervisor: (path, args, options) => {
      const child = processStub();
      background.push({ path, args, options, child });
      return child;
    }
  });
  t.after(() => wizard.close());
  const before = await readFile(join(f.stateRoot, "device-credential.txt"), "utf8");
  assert.equal((await action(wizard, "/api/browser/background/enable", {
    confirmation: "I AUTHORIZE MY BACKGROUND BROWSER"
  })).status, 400);
  await enrollOwnerBrowser(f.stateRoot, f.packageRoot, extensionId);
  assert.equal((await action(wizard, "/api/browser/background/enable", {
    confirmation: "incorrect"
  })).status, 400);
  assert.equal((await action(wizard, "/api/browser/background/enable", {
    confirmation: "I AUTHORIZE MY BACKGROUND BROWSER"
  }, { origin: "https://forged.example" })).status, 403);
  const approved = await action(wizard, "/api/browser/background/enable", {
    confirmation: "I AUTHORIZE MY BACKGROUND BROWSER"
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.connected, "not_verified");
  assert.equal(await readOwnerBrowserBackgroundOptIn(f.stateRoot), true);

  assert.equal((await action(wizard, "/api/start", {
    confirmation: "I APPROVED THIS DEVICE"
  })).status, 200);
  assert.equal((await action(wizard, "/api/browser/background/start-now", {
    confirmation: "START MY APPROVED BACKGROUND DEVICE AND BROWSER"
  })).status, 400, "never race the wizard-owned agent");
  assert.equal(background.length, 0);
  assert.equal((await action(wizard, "/api/stop", {})).status, 200);
  const started = await action(wizard, "/api/browser/background/start-now", {
    confirmation: "START MY APPROVED BACKGROUND DEVICE AND BROWSER"
  });
  assert.equal(started.status, 200);
  assert.equal(started.data.state, "started_not_verified");
  assert.equal(started.data.futureLogon, "requires_owner_enabled_windows_startup");
  assert.equal(background.length, 1);
  assert.ok(background[0].path.endsWith("tetherplane-autostartw.exe"));
  assert.deepEqual(background[0].args, []);
  assert.equal(background[0].options.detached, true);
  assert.equal(background[0].options.windowsHide, true);
  assert.equal(background[0].options.stdio, "ignore");
  assert.equal(background[0].child.unrefCount, 1);
  assert.equal((await action(wizard, "/api/browser/background/start-now", {
    confirmation: "START MY APPROVED BACKGROUND DEVICE AND BROWSER"
  })).status, 400, "one wizard must not spawn duplicate supervisors");

  await wizard.close();
  assert.equal(background[0].child.exitCode, null,
    "the explicitly approved independent supervisor must outlive setup");
  assert.equal(await readFile(join(f.stateRoot, "device-credential.txt"), "utf8"),
    before);
  assert.equal(agents.length, 1);
});
