import { execFile as callbackExecFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  persistApprovedConfig, readSavedConfig
} from "../../packaging/msix-store-runtime/app/runtime-app.mjs";
import { windowsPowerShell51Environment } from "./windows-powershell-env.mjs";

const execFile = promisify(callbackExecFile);
const POWERSHELL = Object.freeze({ windowsHide: true, timeout: 12_000, maxBuffer: 16_384 });
const reportPath = process.argv[2];
const evidence = {
  schema: "tetherplane-restricted-token-credential-v1",
  mode: "SAFER_RESTRICTED_SAME_USER_SID_NOT_SEPARATE_STANDARD_USER",
  privilege_drop: "NOT_TESTED",
  private_state: "NOT_TESTED",
  owner_and_system_acl: "NOT_TESTED",
  existing_state_preserved: "NOT_TESTED",
  credential_restored: "NOT_TESTED",
  cleanup: "NOT_TESTED",
  outcome: "NO_GO"
};

const authorized = process.platform === "win32" &&
  process.env.GITHUB_ACTIONS === "true" &&
  process.env.GITHUB_EVENT_NAME === "pull_request" &&
  process.env.RUNNER_OS === "Windows" &&
  process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
  process.env.GITHUB_HEAD_REF?.startsWith("feature/msix-store-runtime-") &&
  typeof process.env.RUNNER_TEMP === "string" &&
  typeof reportPath === "string" &&
  resolve(reportPath).startsWith(resolve(process.env.RUNNER_TEMP) + "\\");
if (!authorized) {
  console.error("RESTRICTED_CREDENTIAL_PROBE_DENIED: disposable same-repo Windows PR runner only");
  process.exit(3);
}

const powershell = async (code, extraEnv = {}) => {
  const args = ["-NoProfile", "-NonInteractive", "-Command", code];
  return execFile("powershell.exe", args, {
    ...POWERSHELL,
    env: { ...windowsPowerShell51Environment(process.env), ...extraEnv }
  });
};

const privilegeCheck = [
  "$ErrorActionPreference = 'Stop'",
  "$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
  "$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)",
  "if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The token is still an enabled administrator' }",
  "if ($identity.IsSystem) { throw 'System token not permitted' }",
  "'RESTRICTED_NONADMIN_TOKEN_PASS'"
].join("\n");

const aclCheck = [
  "$ErrorActionPreference = 'Stop'",
  "$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$permitted = @($owner, 'S-1-5-18')",
  "$paths = @($env:TP_RESTRICTED_STATE, $env:TP_RESTRICTED_SECRET, $env:TP_RESTRICTED_CONFIG)",
  "for ($i=0; $i -lt $paths.Count; $i++) {",
  "  $acl = if ($i -eq 0) { [System.IO.Directory]::GetAccessControl($paths[$i]) } else { [System.IO.File]::GetAccessControl($paths[$i]) }",
  "  if ($i -eq 0 -and -not $acl.AreAccessRulesProtected) { throw 'Unexpected inherited root DACL' }",
  "  $rules = @($acl.Access)",
  "  $seen = @()",
  "  foreach ($rule in $rules) {",
  "    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
  "    if ($permitted -notcontains $sid) { throw 'Unexpected principal in state DACL' }",
  "    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'Unexpected DACL denial' }",
  "    $seen += $sid",
  "  }",
  "  if ($seen -notcontains $owner -or $seen -notcontains 'S-1-5-18') { throw 'Required owner/SYSTEM rights missing' }",
  "}",
  "'RESTRICTED_STATE_DACL_PASS'"
].join("\n");

let fixtureRoot = null;
try {
  const token = await powershell(privilegeCheck);
  if (!token.stdout.includes("RESTRICTED_NONADMIN_TOKEN_PASS"))
    throw new Error("Non-admin token attestation missing");
  evidence.privilege_drop = "PASS";

  fixtureRoot = await mkdtemp(join(tmpdir(), "tetherplane-restricted-token-"));
  const stateRoot = join(fixtureRoot, "new-device-state");
  const allowedRoot = join(fixtureRoot, "allowed");
  await mkdir(allowedRoot);
  const secret = randomBytes(32).toString("base64url");
  const data = {
    deviceId: "tp-ci-restricted-" + randomBytes(3).toString("hex"),
    relayUrl: "wss://relay.example.test/device",
    allowRoot: allowedRoot,
    secret,
    expiresAt: Date.now() + 60_000
  };
  await persistApprovedConfig(stateRoot, data);
  evidence.private_state = "PASS";

  const stored = (await readFile(join(stateRoot, "device-credential.txt"), "utf8")).trim();
  const config = await readSavedConfig(stateRoot);
  if (stored !== secret || config?.deviceId !== data.deviceId)
    throw new Error("Synthetic native credential-file contract failed");
  evidence.credential_restored = "PASS";

  const acl = await powershell(aclCheck, {
    TP_RESTRICTED_STATE: stateRoot,
    TP_RESTRICTED_SECRET: join(stateRoot, "device-credential.txt"),
    TP_RESTRICTED_CONFIG: join(stateRoot, "device.json")
  });
  if (!acl.stdout.includes("RESTRICTED_STATE_DACL_PASS"))
    throw new Error("Independent restricted-token DACL check missing");
  evidence.owner_and_system_acl = "PASS";

  const foreign = join(fixtureRoot, "foreign-state");
  await mkdir(foreign);
  await writeFile(join(foreign, "sentinel.txt"), "unchanged");
  let refused = false;
  try { await persistApprovedConfig(foreign, data); }
  catch { refused = true; }
  if (!refused ||
      (await readFile(join(foreign, "sentinel.txt"), "utf8")) !== "unchanged" ||
      existsSync(join(foreign, "device-credential.txt")) ||
      existsSync(join(foreign, "device.json"))) {
    throw new Error("Foreign state was modified or adopted");
  }
  evidence.existing_state_preserved = "PASS";
  evidence.outcome = "PASS";
} catch {
  // Credentials, user SID, paths and exceptions are intentionally excluded.
  console.error("RESTRICTED_CREDENTIAL_PROBE_NO_GO: inspect phase-only evidence");
} finally {
  try {
    if (fixtureRoot) {
      await rm(fixtureRoot, { recursive: true, force: true });
      if (existsSync(fixtureRoot)) throw new Error("temp state remained");
    }
    evidence.cleanup = "PASS";
  } catch {
    evidence.cleanup = "FAIL";
    evidence.outcome = "NO_GO";
  }
  try {
    await writeFile(reportPath, JSON.stringify(evidence) + "\n", { flag: "wx" });
  } catch {
    console.error("RESTRICTED_CREDENTIAL_REPORT_NOT_WRITTEN");
    process.exitCode = 1;
  }
}
if (evidence.outcome !== "PASS" || evidence.cleanup !== "PASS") process.exitCode = 1;
else console.log("RESTRICTED_CREDENTIAL_SAME_USER_TOKEN_PASS: no user creation; real standard-user acceptance untested");
