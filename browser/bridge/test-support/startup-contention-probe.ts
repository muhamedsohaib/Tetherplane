// Disposable CI experiment: isolate browser startup from Browser Lab operations.
// Each invocation is one trial; the supervisor starts five separate invocations.
import { launchCdpOwnedBrowser } from "../src/cdp-control.ts";

const sessions = Number(process.argv[2]);
if (sessions !== 1 && sessions !== 2) throw new Error("expected one or two disposable sessions");
const results = await Promise.allSettled(Array.from({ length: sessions }, async (_, slot) => {
  let cleanupVerified = false;
  const control = await launchCdpOwnedBrowser({
    launchTimeoutMs: 12_000,
    onStartupDiagnostic: event => {
      if (event.stage === "cleanup") cleanupVerified = event.profile_removed === true && event.launcher_stopped === true && event.browser_process_stopped === true;
      console.log("CDP_STARTUP=" + JSON.stringify({ slot, ...event }));
    },
  });
  await control.close();
  if (!cleanupVerified) throw Object.assign(new Error("owned startup cleanup is unverified"), { code: "cleanup_unverified" });
}));
const codes = results.map(result => result.status === "fulfilled" ? "success" :
  ["timeout", "provider_failure", "capability_unavailable", "cleanup_unverified"].includes(result.reason?.code) ? result.reason.code as string : "other");
const passed = codes.every(code => code === "success");
console.log("CDP_PROBE_RESULT=" + JSON.stringify({ sessions, passed, codes }));
process.exitCode = passed ? 0 : 1;
