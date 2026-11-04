// Opt-in first-device pairing for the Windows developer beta.
// Generates an independent device credential and a status-only local principal.
// No OAuth client registration, auto-approval, persistence or agent replacement.
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SID_PATTERN = /S-1-(?:\d+-){1,}\d+/i;
const DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CAPABILITIES = Object.freeze(["device.status", "device.capabilities"]);

export function validateRelayUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error("PAIRING_RELAY_URL_INVALID"); }
  if (url.protocol !== "https:" || !url.hostname ||
      url.username || url.password || url.search || url.hash ||
      url.pathname !== "/" || /\s/.test(value)) {
    throw new Error("PAIRING_REQUIRES_CANONICAL_HTTPS_RELAY_ORIGIN");
  }
  return url.origin;
}

export function validateDeviceId(value) {
  if (!DEVICE_PATTERN.test(value ?? "")) {
    throw new Error("PAIRING_INVALID_DEVICE_ID");
  }
  return value;
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function checkedProcess(program, args) {
  const result = spawnSync(program, args, {
    windowsHide: true, encoding: "utf8", timeout: 7000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("PAIRING_WINDOWS_PRIVATE_ACL_UNAVAILABLE");
  }
  return result.stdout ?? "";
}

export function protectWindowsEnrollmentDirectory(directory) {
  if (process.platform !== "win32") {
    throw new Error("PAIRING_WINDOWS_ONLY");
  }
  const account = checkedProcess("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
  const sid = account.match(SID_PATTERN)?.[0];
  if (!sid) throw new Error("PAIRING_WINDOWS_USER_SID_UNAVAILABLE");
  // Remove inherited access and retain only the current owner and SYSTEM.
  // The directory is private before any credential is written.
  checkedProcess("icacls.exe", [
    directory, "/inheritance:r", "/grant:r",
    "*" + sid + ":(OI)(CI)F", "*S-1-5-18:(OI)(CI)F",
  ]);
  return { userSid: sid };
}

export async function beginPairing(input, deps = {}) {
  const relayUrl = validateRelayUrl(input.relayUrl);
  const deviceId = validateDeviceId(input.deviceId);
  if (!input.allowedRoot || !path.isAbsolute(input.allowedRoot) ||
      !input.outputBase || !path.isAbsolute(input.outputBase)) {
    throw new Error("PAIRING_REQUIRES_ABSOLUTE_ALLOWED_AND_OUTPUT_PATHS");
  }
  const allowedRoot = await realpath(input.allowedRoot);
  const outputBase = await realpath(input.outputBase);
  if (!(await lstat(allowedRoot)).isDirectory() ||
      !(await lstat(outputBase)).isDirectory()) {
    throw new Error("PAIRING_PATH_NOT_DIRECTORY");
  }
  if (containsPath(allowedRoot, outputBase)) {
    throw new Error("PAIRING_CREDENTIAL_STORAGE_WITHIN_ALLOWED_ROOT");
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const protectDir = deps.protectDir ?? protectWindowsEnrollmentDirectory;
  const newCredential = deps.newCredential ?? (() => randomBytes(32).toString("base64url"));
  const credential = newCredential();
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) {
    throw new Error("PAIRING_CREDENTIAL_GENERATOR_FAILED");
  }
  const secretHash = createHash("sha256").update(credential, "utf8").digest("hex");
  const dir = await mkdtemp(path.join(outputBase, "tp-device-enroll-"));
  let success = false;
  try {
    protectDir(dir);
    const credentialFile = path.join(dir, "device.credential");
    const profileFile = path.join(dir, "principal.json");
    const stateDir = path.join(dir, "state");
    await writeFile(credentialFile, credential + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeFile(profileFile, JSON.stringify({
      principal_id: "operator:beta-" + deviceId,
      authentication: "local_process_binding",
      allowed_devices: [deviceId],
      allowed_capabilities: CAPABILITIES,
      allowed_roots: [allowedRoot],
    }, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await mkdir(stateDir, { mode: 0o700 });
    // Send the SHA-256 digest, never the device credential.
    const response = await fetchFn(relayUrl + "/pair/start", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ deviceId, credentialHash: secretHash }),
      signal: AbortSignal.timeout(8500),
      redirect: "error",
    });
    if (!response.ok) throw new Error("PAIRING_RELAY_REJECTED_REQUEST_" + response.status);
    let reply;
    try { reply = await response.json(); }
    catch { throw new Error("PAIRING_RELAY_INVALID_RESPONSE"); }
    const expiresAtMs = Date.parse(reply?.expiresAt ?? "");
    if (!reply || typeof reply !== "object" ||
        !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reply.userCode ?? "") ||
        !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() ||
        expiresAtMs > Date.now() + 60 * 60_000) {
      throw new Error("PAIRING_RELAY_INVALID_CODE_OR_EXPIRY");
    }
    const metadata = {
      version: 1, deviceId, relayUrl, allowedRoot,
      credentialFile: "device.credential",
      principalFile: "principal.json",
      stateDir: "state",
      approval: "REQUIRES_SEPARATE_AUTHENTICATED_OWNER_APPROVAL",
      createdAt: new Date().toISOString(),
    };
    await writeFile(path.join(dir, "enrollment.json"), JSON.stringify(metadata, null, 2) + "\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 });
    success = true;
    return { directory: dir, deviceId, userCode: reply.userCode, expiresAt: reply.expiresAt };
  } finally {
    if (!success) {
      // Only the unique directory created by this invocation can be removed.
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export async function loadEnrollment(directory) {
  if (!path.isAbsolute(directory)) throw new Error("PAIRING_ENROLLMENT_PATH_NOT_ABSOLUTE");
  const dir = await realpath(directory);
  const meta = JSON.parse(await readFile(path.join(dir, "enrollment.json"), "utf8"));
  if (meta?.version !== 1 || meta.approval !== "REQUIRES_SEPARATE_AUTHENTICATED_OWNER_APPROVAL" ||
      !DEVICE_PATTERN.test(meta.deviceId ?? "")) {
    throw new Error("PAIRING_ENROLLMENT_INVALID_MANIFEST");
  }
  validateRelayUrl(meta.relayUrl);
  // Reject attacker-controlled filenames and symlink targets.
  const fileNames = [meta.credentialFile, meta.principalFile, meta.stateDir];
  if (JSON.stringify(fileNames) !== JSON.stringify(["device.credential","principal.json","state"])) {
    throw new Error("PAIRING_ENROLLMENT_UNEXPECTED_FILE_NAMES");
  }
  const credentialFile = path.join(dir, meta.credentialFile);
  const principalFile = path.join(dir, meta.principalFile);
  const stateDir = path.join(dir, meta.stateDir);
  for (const target of [credentialFile, principalFile, stateDir]) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !containsPath(dir, await realpath(target))) {
      throw new Error("PAIRING_ENROLLMENT_UNTRUSTED_PATH");
    }
  }
  if (!(await lstat(credentialFile)).isFile() ||
      !(await lstat(principalFile)).isFile() ||
      !(await lstat(stateDir)).isDirectory()) {
    throw new Error("PAIRING_ENROLLMENT_INVALID_TYPES");
  }
  if (typeof meta.allowedRoot !== "string" ||
      !(await lstat(meta.allowedRoot)).isDirectory() ||
      containsPath(await realpath(meta.allowedRoot), dir)) {
    throw new Error("PAIRING_ENROLLMENT_INVALID_ALLOWED_ROOT");
  }
  const profile = JSON.parse(await readFile(principalFile, "utf8"));
  if (profile.principal_id !== "operator:beta-" + meta.deviceId ||
      profile.authentication !== "local_process_binding" ||
      JSON.stringify(profile.allowed_devices) !== JSON.stringify([meta.deviceId]) ||
      JSON.stringify(profile.allowed_capabilities) !== JSON.stringify(CAPABILITIES) ||
      JSON.stringify(profile.allowed_roots) !== JSON.stringify([meta.allowedRoot])) {
    throw new Error("PAIRING_LOCAL_PRINCIPAL_CHANGED");
  }
  return { directory: dir, metadata: meta, credentialFile, principalFile, stateDir };
}

export function agentArguments(enrollment) {
  const m = enrollment.metadata;
  const url = new URL(m.relayUrl);
  url.protocol = "wss:";
  url.pathname = "/device";
  return [
    "--relay-url", url.toString(),
    "--device-id", m.deviceId,
    "--device-credential-file", enrollment.credentialFile,
    "--principal-profile", enrollment.principalFile,
    "--allow", m.allowedRoot,
    "--state-dir", enrollment.stateDir,
  ];
}

function parseCli(argv) {
  const [action, ...rest] = argv;
  if (!["pair", "connect"].includes(action)) throw new Error("PAIRING_USAGE_ACTION_PAIR_OR_CONNECT");
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i], value = rest[i + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || flags[name]) {
      throw new Error("PAIRING_USAGE_INVALID_ARGUMENT");
    }
    flags[name] = value;
  }
  const allowed = action === "pair"
    ? ["--relay", "--device-id", "--allow", "--output-base"]
    : ["--enrollment-dir", "--owner-approved"];
  if (Object.keys(flags).some(x => !allowed.includes(x))) {
    throw new Error("PAIRING_USAGE_UNKNOWN_ARGUMENT");
  }
  for (const key of allowed.slice(0, action === "pair" ? 4 : 2)) {
    if (!flags[key]) throw new Error("PAIRING_USAGE_MISSING_" + key.slice(2));
  }
  if (action === "connect" && flags["--owner-approved"] !== "yes") {
    throw new Error("PAIRING_EXPLICIT_OWNER_APPROVAL_CONFIRMATION_REQUIRED");
  }
  return { action, flags };
}

async function interactive(action) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (action === "pair-interactive") {
      console.log("TETHERPLANE OWNER-APPROVED DEVICE PAIRING");
      console.log("This starts a request only. Existing authenticated owner approval is required.");
      const relay = (await rl.question("Trusted HTTPS relay origin (https://host): ")).trim();
      const deviceId = (await rl.question("New unique device ID: ")).trim();
      const allow = (await rl.question("Directory authorized for this device (absolute path): ")).trim();
      if (!process.env.LOCALAPPDATA) throw new Error("PAIRING_WINDOWS_USER_APPDATA_UNAVAILABLE");
      const outputBase = path.join(process.env.LOCALAPPDATA, "Tetherplane", "Enrollments");
      console.log("Device identity files will be stored under: " + outputBase);
      const consent = (await rl.question("Start this new pairing request? Type YES: ")).trim();
      if (consent !== "YES") throw new Error("PAIRING_EXPLICIT_CONFIRMATION_REQUIRED");
      validateRelayUrl(relay);
      validateDeviceId(deviceId);
      const actualAllow = await realpath(allow);
      if (containsPath(actualAllow, outputBase)) {
        throw new Error("PAIRING_CREDENTIAL_STORAGE_WITHIN_ALLOWED_ROOT");
      }
      await mkdir(outputBase, { recursive: true });
      return main(["pair", "--relay", relay, "--device-id", deviceId,
        "--allow", allow, "--output-base", outputBase]);
    }
    const directory = (await rl.question("Enrollment directory from pairing output: ")).trim();
    console.log("Complete authenticated owner approval of the pairing code FIRST.");
    const consent = (await rl.question("Did you approve this code using your owner account? Type YES: ")).trim();
    if (consent !== "YES") throw new Error("PAIRING_EXPLICIT_OWNER_APPROVAL_CONFIRMATION_REQUIRED");
    return main(["connect", "--enrollment-dir", directory, "--owner-approved", "yes"]);
  } finally { rl.close(); }
}

export async function main(argv) {
  if (argv.length === 1 &&
      ["pair-interactive", "connect-interactive"].includes(argv[0])) {
    return interactive(argv[0]);
  }
  const { action, flags } = parseCli(argv);
  if (action === "pair") {
    const result = await beginPairing({
      relayUrl: flags["--relay"], deviceId: flags["--device-id"],
      allowedRoot: flags["--allow"], outputBase: flags["--output-base"],
    });
    console.log("PAIRING_REQUEST_SUBMITTED=YES");
    console.log("OWNER_APPROVAL_REQUIRED=YES");
    console.log("PAIRING_CODE=" + result.userCode);
    console.log("PAIRING_CODE_EXPIRES=" + result.expiresAt);
    console.log("ENROLLMENT_DIRECTORY=" + result.directory);
    console.log("NEXT=Approve this code using your EXISTING authenticated relay owner account.");
    console.log("NEXT=After approval, explicitly run connect with --owner-approved yes.");
    console.log("REMOTE_AUTHENTICATED_OPERATION=NOT_YET_VERIFIED");
    return;
  }
  const info = await loadEnrollment(flags["--enrollment-dir"]);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bin = path.resolve(here, "..", "..", "bin", "tetherd.exe");
  if (!existsSync(bin)) throw new Error("PAIRING_AGENT_BINARY_MISSING");
  console.log("STARTING_EXPLICIT_STATUS_ONLY_REMOTE_AGENT=YES");
  console.log("REMOTE_APPROVAL_NOT_AUTOMATICALLY_VERIFIED=YES");
  console.log("Ctrl+C stops this non-persistent agent session.");
  const child = spawn(bin, agentArguments(info), {
    stdio: "inherit", windowsHide: false, cwd: info.directory,
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) throw new Error("PAIRING_AGENT_EXITED_" + (result.code ?? result.signal));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const raw = error instanceof Error ? error.message : "";
    // Never echo the remote endpoint, response body, credential or filesystem errors.
    const code = /^PAIRING_[A-Z0-9_]+$/.test(raw)
      ? raw : "PAIRING_NETWORK_OR_FILESYSTEM_FAILURE";
    console.error("TETHERPLANE_ENROLLMENT_FAILED: " + code);
    process.exitCode = 1;
  });
}
