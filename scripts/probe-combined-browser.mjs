import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { callUpstream } from "./browser-unified-rpc-host.mjs";

const port = process.argv.includes("--owner-only") ? 17657 : 17660;
const requireApproved = process.argv.includes("--require-approved");
const tokenPath = path.join(process.env.LOCALAPPDATA ?? "", "Tetherplane", "browser-bridge.token");
const token = (await readFile(tokenPath, "utf8")).trim();
async function invoke(operation, args={}) {
  return await callUpstream({
    port,
    timeoutMs: 3000,
    request: {
      type: operation === "handshake" ? "handshake" : "invoke",
      request_id: randomUUID(),
      token,
      ...(operation === "handshake" ? {} : {
        capability: "browser." + operation,
        arguments: args,
      }),
    },
  });
}
const proof = { endpoint: "127.0.0.1:" + port,
  authenticated: false, connected: false, owned_tab_count: 0,
  approved_tab_count: 0, backend: "UNKNOWN", verdict: "NO_GO" };
try {
  const handshake = await invoke("handshake");
  if (handshake.status !== "success")throw new Error("Handshake denied");
  proof.authenticated = true;
  const status = await invoke("status");
  if (status.status !== "success")throw new Error("Status unavailable");
  proof.backend = status.data?.capabilities?.backend ?? "UNKNOWN";
  proof.connected = status.data?.available === true;
  if(port===17660 && proof.backend!=="cdp_plus_owner_authorized_extension"){
    throw new Error("Unexpected combined backend");
  }
  if(port===17657 && proof.backend!=="extension_authenticated_profile"){
    throw new Error("Unexpected owner backend");
  }
  const pages=await invoke("pages");
  if(pages.status!=="success"||!Array.isArray(pages.data?.pages)){
    throw new Error("Cannot enumerate authorized pages");
  }
  const all=pages.data.pages;
  if(all.some(p=>p.ownership==="human")){
    throw new Error("Unshared human page leaked");
  }
  proof.owned_tab_count=all.filter(p=>p.ownership==="tetherplane").length;
  proof.approved_tab_count=all.filter(p=>
    p.page_id?.startsWith("tab:")&&
    p.ownership==="shared-authorized").length;
  if(requireApproved && proof.approved_tab_count<1){
    throw new Error("NO_OWNER_APPROVED_TAB_VISIBLE");
  }
  proof.verdict="PROBE_OK";
}catch(e){
  proof.reason=e.message;
  process.exitCode=1;
}
console.log(JSON.stringify(proof));
