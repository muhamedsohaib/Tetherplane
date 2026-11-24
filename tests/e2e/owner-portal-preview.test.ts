import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/owner-portal-preview.mjs", import.meta.url));
const publicOrigin = "https://preview.example:9448";
const previewEnv = { ...process.env, TETHERPLANE_PREVIEW_TOKEN: "" };

type Ready = { ready: boolean; httpUrl: string; portalUrl: string; ownerToken: string; devices: string[] };

test("private HTTPS preview pins its origin, preserves synthetic auth, and uses secure sessions", { timeout: 30_000 }, async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "tether-preview-test-"));
  const child = spawn(process.execPath, [script, "--port", "0", "--public-origin", publicOrigin, "--state-dir", stateDir, "--json-ready"], {
    env: previewEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const ready = await new Promise<Ready>((resolve, reject) => {
    let stdout = "";
    child.once("error", reject);
    child.once("exit", (code) => {
      const missingFlag = stderr.includes("Unknown or incomplete option: --public-origin");
      reject(new Error(missingFlag ? "Preview does not support --public-origin" : "Preview exited before readiness: " + code));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let newline: number;
      while ((newline = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (line.startsWith('{"ready":true,')) {
          try { resolve(JSON.parse(line) as Ready); }
          catch { reject(new Error("Invalid preview readiness payload")); }
        }
      }
    });
  });
  assert.equal(ready.portalUrl, publicOrigin + "/portal");
  assert.equal(new URL(ready.httpUrl).hostname, "127.0.0.1");
  const sessionUrl = ready.httpUrl + "/portal/api/session";
  const overviewUrl = ready.httpUrl + "/portal/api/overview";
  assert.equal((await fetch(overviewUrl)).status, 401);
  assert.equal((await fetch(sessionUrl, {
    method: "POST", headers: { origin: publicOrigin, authorization: "Bearer invalid-preview-token" },
  })).status, 401);
  assert.equal((await fetch(sessionUrl, {
    method: "POST", headers: { origin: "https://wrong.example", authorization: "Bearer " + ready.ownerToken },
  })).status, 403);
  const login = await fetch(sessionUrl, {
    method: "POST", headers: { origin: publicOrigin, authorization: "Bearer " + ready.ownerToken },
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.getSetCookie()[0] ?? "";
  for (const attr of [/;\s*Secure\b/i, /;\s*HttpOnly\b/i, /;\s*SameSite=Strict\b/i, /;\s*Path=\/portal\b/i]) {
    assert.ok(attr.test(setCookie), "Expected secure preview session cookie attributes");
  }
  const cookie = setCookie.split(";")[0]!;
  const session = await login.json() as { authenticated: boolean; ownerPrincipalId: string; csrfToken: string };
  assert.equal(session.authenticated, true);
  assert.equal(session.ownerPrincipalId, "human:owner-preview");
  const overviewResponse = await fetch(overviewUrl, { headers: { cookie } });
  assert.equal(overviewResponse.status, 200);
  const overview = await overviewResponse.json() as { devices: { deviceId: string }[] };
  assert.deepEqual(overview.devices.map((device) => device.deviceId).sort(), ["Synth-GPU", "Synth-Laptop", "Synth-Tablet", "Synth-Workstation"]);
  assert.equal((await fetch(sessionUrl + "/logout", {
    method: "POST", headers: { cookie, origin: publicOrigin },
  })).status, 403);
  assert.equal((await fetch(sessionUrl + "/logout", {
    method: "POST", headers: { cookie, origin: publicOrigin, "x-tetherplane-csrf": session.csrfToken },
  })).status, 200);
  assert.equal((await fetch(overviewUrl, { headers: { cookie } })).status, 401);
});

test("private preview origin does not relax the loopback bind guard", () => {
  const result = spawnSync(process.execPath, [script, "--host", "0.0.0.0", "--public-origin", publicOrigin], {
    env: previewEnv, encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing non-loopback host/);
});

test("private preview rejects invalid or plaintext proxy origins before startup", async (t) => {
  for (const origin of ["http://preview.example", "http://127.0.0.1:9448", "https://user:password@preview.example", "https://preview.example/portal", "https://preview.example?query=yes", "https://preview.example/#fragment"]) {
    await t.test(origin.replace("user:password@", "[userinfo]@"), () => {
      const result = spawnSync(process.execPath, [script, "--public-origin", origin, "--port", "0"], {
        env: previewEnv, encoding: "utf8", timeout: 10_000, windowsHide: true,
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--public-origin/);
      assert.doesNotMatch(result.stdout, /"ready":true/);
    });
  }
});
