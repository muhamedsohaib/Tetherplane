/**
 * Read-only owner-granted browser stability acceptance. No page contents,
 * full URL paths, tab IDs, cookies or tokens are emitted.
 * Usage: node scripts/browser-owner-stability.mjs
 *    --expected-origin=https://example.org --cycles=20 --interval-ms=1000
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { callUpstream } from "./browser-unified-rpc-host.mjs";

export function classify(result) {
  if (result?.status === "success" && Array.isArray(result.data?.nodes)) {
    return "success";
  }
  if (result?.status === "error") {
    const code = String(result.error?.code ?? "");
    return [
      "timeout", "provider_busy", "permission_denied",
      "provider_failure", "capability_unavailable", "tab_suspended",
    ].includes(code) ? code : "other_error";
  }
  return "invalid_response";
}

export function summary(samples) {
  const latencies = samples.filter(x => x.kind === "success")
    .map(x => x.duration_ms).sort((a,b) => a-b);
  const counts = {};
  for (const sample of samples) counts[sample.kind] = (counts[sample.kind] ?? 0) + 1;
  const percentile = p => latencies.length
    ? latencies[Math.max(0,Math.ceil(latencies.length*p)-1)] : null;
  return {
    attempted: samples.length,
    successful: counts.success ?? 0,
    failures: samples.length - (counts.success ?? 0),
    errors: Object.fromEntries(Object.entries(counts).filter(([k]) => k !== "success")),
    latency_ms: {p50:percentile(0.5),p95:percentile(0.95),max:percentile(1)},
  };
}

export function validateArgs(argv) {
  const get = k => argv.find(x => x.startsWith("--" + k + "="))?.slice(k.length + 3);
  const originText = get("expected-origin");
  if (!originText) throw new Error("exact expected-origin required");
  const parsed = new URL(originText);
  if (!["http:","https:"].includes(parsed.protocol) ||
      parsed.username || parsed.password || parsed.origin !== originText) {
    throw new Error("expected-origin must be an exact HTTP(S) origin");
  }
  const cycles = Number(get("cycles") ?? 20);
  const intervalMs = Number(get("interval-ms") ?? 1000);
  if (!Number.isSafeInteger(cycles) || cycles < 5 || cycles > 60) {
    throw new Error("cycles must be 5-60");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 5000) {
    throw new Error("interval-ms must be 100-5000");
  }
  return { origin:parsed.origin, cycles, intervalMs };
}

async function acceptance() {
  const config = validateArgs(process.argv.slice(2));
  const started = Date.now();
  const report = {
    checked_at_utc: new Date(started).toISOString(),
    expected_origin: config.origin,
    samples_requested: config.cycles,
    grant_verified: false, sample_groups: [], verdict: "NO_GO",
  };
  let exitCode = 1;
  try {
    const tokenPath = path.join(process.env.LOCALAPPDATA ?? "", "Tetherplane", "browser-bridge.token");
    const token = (await readFile(tokenPath,"utf8")).trim();
    if (token.length < 16) throw new Error("BROWSER_TOKEN_NOT_AVAILABLE");
    const rpc = async (op,args={},timeoutMs=7500) => {
      const start=Date.now();
      try {
        const result=await callUpstream({
          port:17657,timeoutMs,request:{
            type:"invoke",request_id:randomUUID(),token,
            capability:"browser." + op,arguments:args,
          },
        });
        return {result,duration_ms:Date.now()-start};
      } catch(error) {
        const cause=error instanceof Error ? error.message : "";
        return {result:null,duration_ms:Date.now()-start,
          transport_code:cause.includes("deadline")?"transport_timeout":"transport_error"};
      }
    };
    const first=await rpc("pages",{},3500);
    if(first.result?.status!=="success"||!Array.isArray(first.result.data?.pages)) {
      throw new Error("INITIAL_PAGE_LIST_UNAVAILABLE");
    }
    const approved=first.result.data.pages.filter(p => {
      try {
        return p.ownership==="shared-authorized" &&
          /^tab:\d+$/.test(p.page_id) && new URL(p.url).origin===config.origin;
      } catch { return false; }
    });
    if(approved.length!==1) throw new Error("EXACTLY_ONE_OWNER_SHARED_TAB_REQUIRED");
    report.grant_verified=true;
    const id=approved[0].page_id;
    const samples=[];
    let revoked=false;
    for(let i=0;i<config.cycles;i++) {
      const observed=await rpc("snapshot",{page_id:id},7500);
      const kind=observed.transport_code ?? classify(observed.result);
      samples.push({kind,duration_ms:observed.duration_ms});
      if(kind==="permission_denied") { revoked=true;break; }
      if((i+1)%5===0 || i+1===config.cycles) {
        const group=samples.slice(Math.floor(i/5)*5);
        report.sample_groups.push({through:i+1,...summary(group)});
      }
      if(i+1<config.cycles) await sleep(config.intervalMs);
    }
    const final=summary(samples);
    report.total=final;
    report.elapsed_seconds=Math.round((Date.now()-started)/100)/10;
    report.verdict=(!revoked && samples.length===config.cycles &&
      final.successful===config.cycles)
      ? "OWNER_SHARED_TAB_STABILITY_PASS":"OWNER_SHARED_TAB_STABILITY_FAIL";
    exitCode=report.verdict.endsWith("_PASS")?0:1;
  } catch(e) {
    const msg=e instanceof Error?e.message:"";
    report.reason=/^(BROWSER_TOKEN_NOT_AVAILABLE|INITIAL_PAGE_LIST_UNAVAILABLE|EXACTLY_ONE_OWNER_SHARED_TAB_REQUIRED)$/.test(msg)
      ? msg:"INVALID_INPUT_OR_LOCAL_STATE";
  }
  console.log(JSON.stringify(report));
  process.exitCode=exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  await acceptance();
}
