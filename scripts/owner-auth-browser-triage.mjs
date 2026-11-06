/**
 * Read-only, owner-authorized browser path triage.
 * Intentionally displays only request status/timings/counters; no page
 * contents, URL paths, cookies, credential material, or response payloads.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { callUpstream } from "./browser-unified-rpc-host.mjs";

const opt = process.argv.find(v => v.startsWith("--expected-origin="));
const expected = opt?.slice("--expected-origin=".length);
const report = { checked_at_utc: new Date().toISOString(),
  endpoint: "127.0.0.1:17657", expected_origin: null, approved_count: 0,
  steps: [], verdict: "NO_GO" };
let exit = 1;
try {
  if (!expected) throw new Error("MISSING_EXPECTED_ORIGIN");
  const origin = new URL(expected);
  if (!["https:", "http:"].includes(origin.protocol) || origin.origin !== expected ||
      origin.username || origin.password) throw new Error("INVALID_EXACT_ORIGIN");
  report.expected_origin = origin.origin;
  const file = path.join(process.env.LOCALAPPDATA ?? "", "Tetherplane", "browser-bridge.token");
  const token = (await readFile(file, "utf8")).trim();
  if (token.length < 16) throw new Error("LOCAL_BRIDGE_TOKEN_UNAVAILABLE");
  async function rpc(op, args, timeoutMs) {
    const start = Date.now();
    try {
      const result = await callUpstream({ port: 17657, timeoutMs, request: {
        type: "invoke", request_id: randomUUID(), token,
        capability: "browser." + op, arguments: args ?? {},
      }});
      report.steps.push({
        operation: op, elapsed_ms: Date.now()-start, status: result.status,
        code: result.status === "error"
          ? String(result.error?.code ?? "unknown").slice(0,50):null,
      });
      return result;
    } catch (e) {
      report.steps.push({ operation: op, elapsed_ms: Date.now()-start,
        status: "transport_error", code: e.message.includes("deadline")
          ? "UPSTREAM_DEADLINE" : "UPSTREAM_UNAVAILABLE" });
      return null;
    }
  }
  const first = await rpc("pages", {}, 3000);
  if (first?.status !== "success" || !Array.isArray(first.data?.pages)) {
    throw new Error("LIST_INITIAL_FAILED");
  }
  const approved = first.data.pages.filter(p => {
    try {
      return p?.ownership === "shared-authorized" &&
        /^tab:\d+$/.test(p.page_id) &&
        new URL(p.url).origin === expected;
    } catch { return false; }
  });
  report.approved_count = approved.length;
  if (approved.length !== 1) throw new Error("EXPECTED_ONE_EXPLICITLY_SHARED_TAB");
  const tabId = approved[0].page_id;
  const snapshot = await rpc("snapshot", { page_id: tabId }, 8000);
  if (snapshot?.status !== "success") throw new Error("SNAPSHOT_FAILED");
  // Do not log/return nodes, names, values, application state or full URL.
  report.steps[report.steps.length-1].node_count =
    Array.isArray(snapshot.data?.nodes) ? snapshot.data.nodes.length : null;
  const again = await rpc("pages", {}, 3000);
  if (again?.status !== "success" || !Array.isArray(again.data?.pages))
    throw new Error("LIST_AFTER_SNAPSHOT_FAILED");
  if (!again.data.pages.some(p => p?.page_id === tabId &&
    p.ownership === "shared-authorized"))
    throw new Error("GRANT_REVOKED_DURING_READ");
  report.verdict = "ONE_AUTHORIZED_READ_SEQUENCE_PASS";
  exit = 0;
} catch(e) {
  report.reason = String(e.message || "UNEXPECTED_FAILURE").slice(0,100);
}
console.log(JSON.stringify(report));
process.exitCode = exit;
