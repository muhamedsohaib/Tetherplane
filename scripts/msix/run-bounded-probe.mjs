import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { windowsPowerShell51Environment } from "./windows-powershell-env.mjs";

const environment = process.env;
const permitted =
  environment.GITHUB_ACTIONS === "true" &&
  environment.GITHUB_EVENT_NAME === "pull_request" &&
  environment.RUNNER_OS === "Windows" &&
  environment.RUNNER_ENVIRONMENT === "github-hosted" &&
  environment.GITHUB_HEAD_REF?.startsWith("feature/msix-feasibility-") &&
  environment.RUNNER_TEMP;

if (!permitted) {
  console.error("MSIX_PROBE_DENIED: disposable same-repo PR runner required");
  process.exitCode = 1;
} else {
  const report = join(environment.RUNNER_TEMP, "tetherplane-msix-probe-report.json");
  const script = join("scripts", "msix", "Test-TetherplaneMsixFeasibility.ps1");
  const timeoutMs = 120_000;

  console.log("MSIX_PROBE_LAUNCH: development-only, bounded Windows process");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile", "-NonInteractive", "-File", script,
      "-AgentBinary", join("target", "release", "tetherd.exe"),
      "-ReportPath", report,
    ],
    {
      shell: false,
      stdio: "inherit",
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      env: windowsPowerShell51Environment(environment),
    },
  );

  child.on("error", (error) => {
    console.error("MSIX_PROBE_SPAWN_ERROR:", error.code || error.message);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    let phase = "NO_REPORT";
    let disposition = "NO-GO";
    try {
      const evidence = JSON.parse(readFileSync(report, "utf8"));
      phase = evidence.last_phase || "UNKNOWN";
      disposition = evidence.disposition || "NO-GO";
    } catch {
      // An absent report is a failed experiment, never evidence of success.
    }
    console.log(`MSIX_PROBE_EVIDENCE: last_phase=${phase}; disposition=${disposition}`);
    if (signal) {
      console.error(`MSIX_PROBE_BOUNDED_TERMINATION: ${signal}; upper_bound_ms=${timeoutMs}`);
    }
    if (code !== 0 || signal) {
      console.error("MSIX_PROBE_NO_GO: see data-only phase report; no public signing or release");
      process.exitCode = 1;
    } else if (disposition !== "PACKAGE_INSTALL_REMOVE_PASS; STORE/OAUTH/STARTUP NOT TESTED") {
      console.error("MSIX_PROBE_NO_GO: expected final install/remove report not observed");
      process.exitCode = 1;
    } else {
      console.log("MSIX_PROBE_INSTALL_REMOVE_PASS: Store/OAuth/startup remain unverified");
    }
  });
}
