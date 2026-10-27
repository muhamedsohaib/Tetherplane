import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const env = process.env;
const permitted = process.platform === "win32" &&
  env.GITHUB_ACTIONS === "true" &&
  env.GITHUB_EVENT_NAME === "pull_request" &&
  env.RUNNER_OS === "Windows" &&
  env.RUNNER_ENVIRONMENT === "github-hosted" &&
  env.GITHUB_HEAD_REF?.startsWith("feature/msix-store-runtime-") &&
  env.RUNNER_TEMP &&
  env.GITHUB_WORKSPACE;

if (!permitted) {
  console.error("RESTRICTED_TOKEN_CI_DENIED: disposable same-repo Windows PR required");
  process.exit(3);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const temporary = await mkdtemp(join(env.RUNNER_TEMP, "tp-restricted-"));
const report = join(temporary, "result.json");
const command = join(temporary, "launch.cmd");
const childScript = join(env.GITHUB_WORKSPACE, "scripts", "msix-store", "restricted-token-credential-check.mjs");
const allowedStatuses = ["PASS", "NOT_TESTED"];
let launcher = null;
let launcherExit = null;
let launcherError = null;
let reporter = null;

try {
  // A SAFER restricted token disables the existing runner's enabled admin
  // group; it does not create accounts, install a service, add privileges,
  // change UAC/security settings, or impersonate another user's SID.
  // This is deliberately NOT separate-standard-user acceptance.
  const cmd = '@echo off\r\n"' + process.execPath + '" "' + childScript + '" "' + report +
    '"\r\nexit /b %ERRORLEVEL%\r\n';
  await writeFile(command, cmd, { flag: "wx" });
  const target = 'cmd.exe /d /c "' + command + '"';
  launcher = spawn("runas.exe", ["/trustlevel:0x20000", target], {
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let ioBytes = 0;
  launcher.stdout?.on("data", chunk => { ioBytes += chunk.length; });
  launcher.stderr?.on("data", chunk => { ioBytes += chunk.length; });
  launcher.once("error", error => { launcherError = error?.code || "SPAWN_FAILURE"; });
  launcher.once("close", code => { launcherExit = code; });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !existsSync(report)) {
    if (launcherError || (launcherExit !== null && launcherExit !== 0))
      throw new Error("RUNAS_LAUNCH_DENIED");
    await sleep(350);
  }
  if (!existsSync(report)) throw new Error("RESTRICTED_PROBE_REPORT_TIMEOUT");
  reporter = JSON.parse(await readFile(report, "utf8"));
  if (reporter.schema !== "tetherplane-restricted-token-credential-v1" ||
      reporter.mode !== "SAFER_RESTRICTED_SAME_USER_SID_NOT_SEPARATE_STANDARD_USER" ||
      reporter.outcome !== "PASS" ||
      !["privilege_drop", "private_state", "owner_and_system_acl",
        "existing_state_preserved", "credential_restored", "cleanup"].every(k => reporter[k] === "PASS")) {
    throw new Error("RESTRICTED_PROBE_NO_GO");
  }
  console.log("RESTRICTED_TOKEN_CI_PASS: token reduced, new credential owner/SYSTEM ACL verified, state preserved");
  console.log("RESTRICTED_TOKEN_SCOPE: SAME_USER_SID_NOT_REAL_SECOND_USER; STORE_SAC_NOT_TESTED");
} catch (error) {
  console.error("RESTRICTED_TOKEN_CI_NO_GO: " + String(error?.message).slice(0,100));
  process.exitCode = 1;
} finally {
  if (launcher && launcherExit === null) {
    // Stop only the exact helper spawned by this test; the disposable runner
    // owns its child lifecycle. Do not enumerate, kill or inspect other jobs.
    try { launcher.kill(); } catch {}
  }
  await rm(temporary, { recursive: true, force: true }).catch(() => {
    process.exitCode = 1;
    console.error("RESTRICTED_TOKEN_CI_CLEANUP_FAILED");
  });
}
