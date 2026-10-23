// Disposable CI experiment: isolate browser startup from Browser Lab operations.
// Each invocation is one trial; the supervisor starts five separate invocations.
import { launchCdpOwnedBrowser } from "../src/cdp-control.ts";

const sessions = Number(process.argv[2]);
if (sessions !== 1 && sessions !== 2) throw new Error("expected one or two disposable sessions");
const results = await Promise.allSettled(Array.from({ length: sessions }, async (_, slot) => {
  const control = await launchCdpOwnedBrowser({
    launchTimeoutMs: 12_000,
    onStartupDiagnostic: event => console.log("CDP_STARTUP=" + JSON.stringify({ slot, ...event })),
  });
  await control.close();
}));
const codes = results.map(result => result.status === "fulfilled" ? "success" :
  ["timeout", "provider_failure", "capability_unavailable"].includes(result.reason?.code) ? result.reason.code as string : "other");
const passed = codes.every(code => code === "success");
console.log("CDP_PROBE_RESULT=" + JSON.stringify({ sessions, passed, codes }));
process.exitCode = passed ? 0 : 1;
