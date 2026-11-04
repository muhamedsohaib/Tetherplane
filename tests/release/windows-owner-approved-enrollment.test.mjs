import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  validateRelayUrl, validateDeviceId, beginPairing, loadEnrollment,
  agentArguments, protectWindowsEnrollmentDirectory
} from "../../scripts/windows/remote-enroll.mjs";

const origin = "https://relay.example.test";
const code = "A1B2-C3D4";
const expiry = new Date(Date.now() + 300_000).toISOString();
async function fixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tp-remote-enroll-test-"));
  const allowedRoot = path.join(root, "allowed");
  const outputBase = path.join(root, "enrollments");
  await mkdir(allowedRoot);
  await mkdir(outputBase);
  try { return await fn({ root, allowedRoot, outputBase }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function requestRecorder() {
  const received = [];
  return {
    received,
    async fetchFn(url, request) {
      received.push({ url, request });
      return { ok: true, status: 200, async json() { return { userCode: code, expiresAt: expiry }; } };
    },
  };
}
function input(roots) {
  return { relayUrl: origin, deviceId: "WIN_DEV_GUEST_11", ...roots };
}

test("pairing accepts canonical HTTPS only, no userinfo/query/hash/path/plaintext", () => {
  assert.equal(validateRelayUrl(origin), origin);
  for (const value of [
    "http://relay.example.test", "ws://relay.example.test",
    "wss://relay.example.test", "https://user:pw@relay.example.test",
    "https://relay.example.test/foo", "https://relay.example.test/?x=1",
    "https://relay.example.test/#frag", "not-a-url", "  https://relay.example.test",
  ]) {
    assert.throws(() => validateRelayUrl(value), /PAIRING_/);
  }
});

test("pairing rejects malformed device identities before creating any files", async () => {
  for (const id of ["", "../Surface", "WIN GUEST", "a/../../b", "!", "x".repeat(129)]) {
    assert.throws(() => validateDeviceId(id), /PAIRING_INVALID_DEVICE_ID/);
  }
  assert.equal(validateDeviceId("WIN_DEV_GUEST_11"), "WIN_DEV_GUEST_11");
});

test("successful first pairing sends only SHA-256, prints owner code, creates no privileged principal", async () => {
  await fixture(async (dirs) => {
    const { fetchFn, received } = requestRecorder();
    const outcome = await beginPairing(input(dirs), { fetchFn });
    assert.equal(received.length, 1);
    const call = received[0];
    assert.equal(call.url, origin + "/pair/start");
    assert.equal(call.request.method, "POST");
    assert.equal(call.request.redirect, "error");
    const request = JSON.parse(call.request.body);
    assert.equal(request.deviceId, "WIN_DEV_GUEST_11");
    assert.match(request.credentialHash, /^[a-f0-9]{64}$/);
    const credential = (await readFile(path.join(outcome.directory, "device.credential"), "utf8")).trim();
    assert.equal(credential.length, 43);
    assert.equal(request.credentialHash, createHash("sha256").update(credential).digest("hex"));
    assert.ok(!call.request.body.includes(credential));
    assert.equal(outcome.userCode, code);
    assert.equal(outcome.expiresAt, expiry);
    const metadata = JSON.parse(await readFile(path.join(outcome.directory, "enrollment.json"), "utf8"));
    assert.equal(metadata.approval, "REQUIRES_SEPARATE_AUTHENTICATED_OWNER_APPROVAL");
    assert.ok(!JSON.stringify(metadata).includes(credential));
    const profile = JSON.parse(await readFile(path.join(outcome.directory, "principal.json"), "utf8"));
    assert.deepEqual(profile.allowed_capabilities, ["device.status", "device.capabilities"]);
    assert.deepEqual(profile.allowed_devices, ["WIN_DEV_GUEST_11"]);
    assert.deepEqual(profile.allowed_roots, [await realpath(dirs.allowedRoot)]);
    const validated = await loadEnrollment(outcome.directory);
    const args = agentArguments(validated);
    assert.equal(args[args.indexOf("--relay-url") + 1], "wss://relay.example.test/device");
    assert.ok(args.includes("--principal-profile"));
    assert.ok(args.includes("--device-credential-file"));
    assert.ok(!args.includes(credential));
    const names = await readdir(outcome.directory);
    assert.ok(names.includes("state"));
    assert.ok(names.includes("enrollment.json"));
    // Windows access control must not retain general inherited permissions.
    if (process.platform === "win32") {
      const acl = spawnSync("icacls.exe", [outcome.directory], { encoding: "utf8" });
      assert.equal(acl.status, 0, acl.stderr);
      const output = acl.stdout.toLowerCase();
      assert.doesNotMatch(output, /\b(builtin\\users|everyone|authenticated users):/);
    }
  });
});

test("failed relay pairing removes only the new credential directory", async () => {
  await fixture(async dirs => {
    const sentinel = path.join(dirs.outputBase, "existing-owner-state.txt");
    await writeFile(sentinel, "unchanged");
    await assert.rejects(
      beginPairing(input(dirs), {
        fetchFn: async () => ({ ok: false, status: 409 }),
      }),
      /PAIRING_RELAY_REJECTED_REQUEST_409/,
    );
    assert.deepEqual(await readdir(dirs.outputBase), ["existing-owner-state.txt"]);
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  });
});

test("invalid relay code fails closed without leaving a credential on disk", async () => {
  await fixture(async dirs => {
    await assert.rejects(beginPairing(input(dirs), {
      fetchFn: async () => ({
        ok: true, status: 200, async json() { return { userCode: "not-valid", expiresAt: expiry }; }
      }),
    }), /PAIRING_RELAY_INVALID_CODE_OR_EXPIRY/);
    assert.deepEqual(await readdir(dirs.outputBase), []);
  });
});

test("credential directory cannot be inside the declared allowed root", async () => {
  await fixture(async dirs => {
    await assert.rejects(beginPairing(input({
      allowedRoot: dirs.root, outputBase: dirs.outputBase,
    }), { fetchFn: () => { throw Error("should not submit"); } }),
    /PAIRING_CREDENTIAL_STORAGE_WITHIN_ALLOWED_ROOT/);
    assert.deepEqual(await readdir(dirs.outputBase), []);
  });
});

test("changed principal capability grant is not accepted by the connector", async () => {
  await fixture(async dirs => {
    const outcome = await beginPairing(input(dirs), requestRecorder());
    const profileFile = path.join(outcome.directory, "principal.json");
    const profile = JSON.parse(await readFile(profileFile, "utf8"));
    profile.allowed_capabilities.push("process.run");
    await writeFile(profileFile, JSON.stringify(profile));
    await assert.rejects(loadEnrollment(outcome.directory), /PAIRING_LOCAL_PRINCIPAL_CHANGED/);
  });
});

test("Windows ACL helper rejects unsupported platforms; CLI parse is syntax valid", () => {
  if (process.platform !== "win32") {
    assert.throws(() => protectWindowsEnrollmentDirectory("/tmp/test"), /PAIRING_WINDOWS_ONLY/);
  }
  const script = fileURLToPath(new URL("../../scripts/windows/remote-enroll.mjs", import.meta.url));
  assert.ok(existsSync(script));
  const syntax = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});


test("real Windows tetherd enforces new status-only principal and denies filesystem access", {
  skip: process.platform !== "win32" ||
    !existsSync(process.env.TETHERPLANE_NATIVE_AGENT_FOR_TEST ?? ""),
}, async () => {
  await fixture(async dirs => {
    const created = await beginPairing(input(dirs), requestRecorder());
    const agent = process.env.TETHERPLANE_NATIVE_AGENT_FOR_TEST;
    const message = (capability, requestId, argumentsObject) => ({
      protocol_version: "1.0", request_id: requestId,
      device_id: "WIN_DEV_GUEST_11",
      principal_id: "model:caller-cannot-override",
      job_id: null, capability, arguments: argumentsObject,
      actor: { id: "synthetic-owner", kind: "ai_client" },
      session_id: null, response_mode: "compact",
      idempotency_key: null, preconditions: [], expectations: [],
    });
    const status = message("device.status", "00000000-0000-4000-8000-000000009011", {});
    const refused = message("filesystem.read", "00000000-0000-4000-8000-000000009012",
      { path: path.join(dirs.root, "out-of-scope.txt") });
    const trial = spawnSync(agent, [
      "--stdio-rpc",
      "--principal-profile", path.join(created.directory, "principal.json"),
      "--allow", dirs.allowedRoot,
      "--state-dir", path.join(created.directory, "state"),
    ], {
      encoding: "utf8", timeout: 12000, windowsHide: true,
      input: JSON.stringify(status) + "\n" + JSON.stringify(refused) + "\n",
    });
    assert.equal(trial.status, 0, trial.stderr);
    const outputs = trial.stdout.trim().split(/\r?\n/).map(s => JSON.parse(s));
    assert.equal(outputs.length, 2, trial.stdout);
    // Stdio responses can complete out of order; correlate by request_id.
    const byRequest = new Map(outputs.map(x => [x.request_id, x]));
    assert.equal(byRequest.get(status.request_id)?.status, "success", trial.stdout);
    assert.equal(byRequest.get(refused.request_id)?.status, "error", trial.stdout);
    assert.equal(byRequest.get(refused.request_id)?.error?.code, "permission_denied");
  });
});

test("packaging includes opt-in launchers and never auto-approves enrollment", async () => {
  const script = await readFile(new URL("../../scripts/windows/Build-UnsignedPortableDeveloperBeta.ps1", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../../.github/workflows/windows-portable-developer-beta-candidate.yml", import.meta.url), "utf8");
  assert.match(script, /PAIR NEW DEVICE\.cmd/);
  assert.match(script, /CONNECT APPROVED DEVICE\.cmd/);
  assert.match(script, /remote-enroll\.mjs/);
  assert.match(script, /status_only/);
  assert.match(script, /owner_approval_required = \$true/);
  assert.match(workflow, /windows-owner-approved-enrollment\.test\.mjs/);
  const enrollmentSource = await readFile(new URL("../../scripts/windows/remote-enroll.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(enrollmentSource, /fetchFn\([^)]*pair\/approve/);
});

test("expired owner pairing codes fail closed without leaving credentials", async () => {
  await fixture(async dirs => {
    await assert.rejects(beginPairing(input(dirs), {
      fetchFn: async () => ({
        ok: true, status: 200,
        async json() { return {
          userCode: code,
          expiresAt: new Date(Date.now() - 1000).toISOString()
        }; }
      }),
    }), /PAIRING_RELAY_INVALID_CODE_OR_EXPIRY/);
    assert.deepEqual(await readdir(dirs.outputBase), []);
  });
});
