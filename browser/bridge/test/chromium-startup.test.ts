import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { Readable } from "node:stream";

import { launchCdpOwnedBrowser } from "../src/cdp-control.ts";
import { ChromiumStartupTelemetry, startupErrorCategory, waitForDevToolsActivePort, type ChromiumStartupDiagnostic } from "../src/chromium-startup.ts";

test("failed Chromium launch reports bounded categories and cleanup without paths or raw stderr", { timeout: 10_000 }, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "startup-private-marker-"));
  const events: unknown[] = [];
  try {
    await assert.rejects(launchCdpOwnedBrowser({
      executablePath: process.execPath,
      profileParent: parent,
      launchTimeoutMs: 1_000,
      onStartupDiagnostic: (event: unknown) => events.push(event),
    }), /isolated Chromium exited|failed to launch isolated Chromium/);
    const serialized = JSON.stringify(events);
    assert.match(serialized, /"stage":"selected"/);
    assert.match(serialized, /"stage":"spawn"/);
    assert.match(serialized, /"stage":"exit"/);
    assert.match(serialized, /"stage":"cleanup"/);
    assert.match(serialized, /"profile_removed":true/);
    assert.ok(!serialized.includes(parent));
    assert.ok(!serialized.includes(process.execPath));
    assert.ok(!serialized.includes("--user-data-dir"));
    assert.ok(serialized.length < 12_000);
    assert.deepEqual(await readdir(parent), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("zero-code launcher handoff still requires an endpoint within the original deadline", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-zero-"));
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  const telemetry = new ChromiumStartupTelemetry();
  telemetry.attach(child);
  try {
    await once(child, "close");
    const portFile = path.join(root, "DevToolsActivePort");
    await assert.rejects(waitForDevToolsActivePort({ child, portFile, timeoutMs: 120, telemetry }), /timed out/);
    await writeFile(portFile, "12345\n/devtools/browser/handoff-id\n");
    assert.equal(await waitForDevToolsActivePort({ child, portFile, timeoutMs: 1_000, telemetry }), "ws://127.0.0.1:12345/devtools/browser/handoff-id");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("signalled child exit without an endpoint fails promptly", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-signal-"));
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const telemetry = new ChromiumStartupTelemetry();
  telemetry.attach(child);
  try {
    await once(child, "spawn");
    const closed = once(child, "close");
    child.kill();
    await closed;
    await assert.rejects(waitForDevToolsActivePort({ child, portFile: path.join(root, "DevToolsActivePort"), timeoutMs: 1_000, telemetry }), /isolated Chromium exited/);
  } finally { child.kill(); await rm(root, { recursive: true, force: true }); }
});

test("stderr floods are drained with a bounded scan and split categories never expose their source text", { timeout: 5_000 }, async () => {
  const events: ChromiumStartupDiagnostic[] = [];
  const telemetry = new ChromiumStartupTelemetry(event => events.push(event));
  telemetry.stderr(Buffer.from("Permission de"));
  telemetry.stderr(Buffer.from("nied C:\\Users\\private-marker secret-marker\nDevTools listening on ws://secret-marker\n"));
  const child = spawn(process.execPath, ["-e", "process.stderr.write('x'.repeat(1024*1024));"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  telemetry.attach(child);
  await once(child, "close");
  telemetry.emit("failure");
  const summary = events.at(-1)!;
  assert.equal(summary.stderr_bytes, 16_384);
  assert.equal(summary.stderr_capped, true);
  assert.deepEqual(summary.stderr_categories, ["profile_permission", "devtools_listening"]);
  assert.ok(!JSON.stringify(events).includes("secret-marker"));
  assert.ok(!JSON.stringify(events).includes("private-marker"));
  assert.ok(events.length <= 5);
});

test("missing, invalid and unreadable endpoints time out while a living child remains unready", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-endpoint-"));
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await once(child, "spawn");
    for (const scenario of ["missing", "invalid", "unreadable"] as const) {
      const file = path.join(root, scenario);
      if (scenario === "invalid") await writeFile(file, "99999\n/devtools/browser/fake\n");
      const events: ChromiumStartupDiagnostic[] = [];
      const telemetry = new ChromiumStartupTelemetry(event => events.push(event));
      const started = performance.now();
      await assert.rejects(waitForDevToolsActivePort({ child, portFile: scenario === "unreadable" ? root : file, timeoutMs: 120, telemetry }), /timed out/);
      telemetry.emit("failure");
      assert.equal(events.at(-1)?.endpoint, scenario);
      assert.ok(performance.now() - started >= 120);
      assert.equal(child.exitCode, null);
    }
  } finally {
    const closed = once(child, "close"); child.kill(); await closed;
    await rm(root, { recursive: true, force: true });
  }
});

test("valid endpoint is observed without exposing its URL and throwing diagnostics cannot change the result", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-valid-"));
  const file = path.join(root, "DevToolsActivePort");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await once(child, "spawn");
    await writeFile(file, "12345\n/devtools/browser/fake-id\n");
    const telemetry = new ChromiumStartupTelemetry(() => { throw new Error("diagnostic failure"); });
    assert.equal(await waitForDevToolsActivePort({ child, portFile: file, timeoutMs: 1_000, telemetry }), "ws://127.0.0.1:12345/devtools/browser/fake-id");
  } finally {
    const closed = once(child, "close"); child.kill(); await closed;
    await rm(root, { recursive: true, force: true });
  }
});

test("profile preparation failure is sanitized and does not spawn a browser", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "private-profile-marker-"));
  const parent = path.join(root, "not-a-directory");
  const events: unknown[] = [];
  await writeFile(parent, "fixture");
  try {
    await assert.rejects(launchCdpOwnedBrowser({
      executablePath: process.execPath, profileParent: parent,
      onStartupDiagnostic: (event: unknown) => events.push(event),
    }), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(root), "filesystem error must not expose the profile path");
      assert.match(error.message, /failed to prepare isolated Chromium profile/);
      return true;
    });
    assert.ok(!JSON.stringify(events).includes('"stage":"spawn"'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed write-probe cleanup cannot expose filesystem errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "startup-probe-"));
  const originalWrite = fsPromises.writeFile;
  const originalRm = fsPromises.rm;
  try {
    fsPromises.writeFile = async (...args) => {
      if (String(args[0]).endsWith(".startup-write-probe")) throw Object.assign(new Error("write/private-marker"), { code: "EACCES" });
      return originalWrite(...args);
    };
    fsPromises.rm = async (...args) => {
      if (String(args[0]).includes("tetherplane-cdp-")) throw Object.assign(new Error("rm/private-marker/SECRET"), { code: "EPERM" });
      return originalRm(...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(launchCdpOwnedBrowser({ executablePath: process.execPath, profileParent: root }), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("private-marker"));
      assert.match(error.message, /failed to (?:prepare|clean) isolated Chromium/);
      return true;
    });
  } finally {
    fsPromises.writeFile = originalWrite; fsPromises.rm = originalRm; syncBuiltinESMExports();
    await originalRm(root, { recursive: true, force: true });
  }
});

for (const scenario of ["terminal child", "expired deadline"] as const) {
  test(`endpoint read cannot declare readiness after ${scenario}`, { timeout: 5_000 }, async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
    const originalRead = fs.createReadStream;
    let closed = false;
    try {
      await once(child, "spawn");
      fs.createReadStream = (() => Readable.from((async function* () {
        if (scenario === "terminal child") {
          const done = once(child, "close"); child.kill(); await done; closed = true;
        } else { await new Promise(resolve => setTimeout(resolve, 80)); }
        yield Buffer.from("12345\n/devtools/browser/fixture\n");
      })())) as unknown as typeof originalRead;
      syncBuiltinESMExports();
      await assert.rejects(waitForDevToolsActivePort({ child, portFile: "controlled-fixture", timeoutMs: scenario === "terminal child" ? 500 : 40, telemetry: new ChromiumStartupTelemetry() }), scenario === "terminal child" ? /isolated Chromium exited/ : /timed out/);
    } finally {
      fs.createReadStream = originalRead; syncBuiltinESMExports();
      if (!closed) { const done = once(child, "close"); child.kill(); await done; }
    }
  });
}

test("endpoint deadline abort preserves the last file observation instead of reporting permission failure", { timeout: 5_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const originalRead = fs.createReadStream;
  const events: ChromiumStartupDiagnostic[] = [];
  let reads = 0;
  try {
    await once(child, "spawn");
    fs.createReadStream = (() => Readable.from((async function* () {
      if (reads++ > 0) throw Object.assign(new Error("controlled deadline abort"), { name: "AbortError" });
      yield Buffer.from("invalid endpoint\n");
    })())) as unknown as typeof originalRead;
    syncBuiltinESMExports();
    const telemetry = new ChromiumStartupTelemetry(event => events.push(event));
    await assert.rejects(waitForDevToolsActivePort({ child, portFile: "controlled-fixture", timeoutMs: 250, telemetry }), /timed out/);
    telemetry.emit("failure");
    assert.equal(events.at(-1)?.endpoint, "invalid");
  } finally {
    fs.createReadStream = originalRead; syncBuiltinESMExports();
    const closed = once(child, "close"); child.kill(); await closed;
  }
});

test("flapping endpoint observations keep diagnostics bounded and preserve the safe failure category", () => {
  const events: ChromiumStartupDiagnostic[] = [];
  const telemetry = new ChromiumStartupTelemetry(event => events.push(event));
  for (let i = 0; i < 1_000; i++) telemetry.endpoint(i % 2 === 0 ? "missing" : "unreadable", "permission");
  telemetry.emit("failure");
  assert.ok(events.length < 16, "file state flapping must not create an unbounded diagnostic stream");
  assert.equal(events.at(-1)?.endpoint, "unreadable");
  assert.equal(events.at(-1)?.error_category, "permission");
});

test("startup error normalization distinguishes a busy endpoint without echoing arbitrary errors", () => {
  assert.equal(startupErrorCategory({ code: "EBUSY" }), "busy");
  assert.equal(startupErrorCategory({ code: "ETXTBSY" }), "busy");
  assert.equal(startupErrorCategory({ code: "EACCES" }), "permission");
  assert.equal(startupErrorCategory({ code: "arbitrary-private-marker", message: "secret-marker" }), "other");
});
