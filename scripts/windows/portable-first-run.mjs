// First-run validation of the extracted, full developer-beta package.
// Runs locally with synthetic writable state; no credentials, OAuth or remote relay.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const runtime = path.join(root, "runtime", "node.exe");
const agent = path.join(root, "bin", "tetherd.exe");
const server = path.join(here, "dist", "stdio-server.js");
for (const f of [runtime, agent, server]) {
  if (!existsSync(f)) throw new Error("PORTABLE_BETA_REQUIRED_FILE_MISSING: " + path.basename(f));
}
const started = performance.now();
const temp = mkdtempSync(path.join(tmpdir(), "tetherplane-portable-beta-"));
const allow = path.join(temp, "allowed");
const state = path.join(temp, "state");
mkdirSync(allow);
mkdirSync(state);
const client = new Client({ name: "tetherplane-unsigned-developer-beta-canary", version: "0.1.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: runtime,
  args: [server, "--tetherd", agent, "--allow", allow, "--state-dir", state],
  cwd: here,
  stderr: "inherit",
});
const watchdog = setTimeout(() => { console.error("LOCAL_ACCEPTANCE_TIMEOUT"); process.exit(2); }, 20000);
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["batch", "browser", "desktop", "device", "files", "process"]);
  const status = await client.callTool({ name: "device", arguments: { op: "status", args: {} } });
  assert.notEqual(status.isError, true, "native device.status was rejected");
  const firstStatusMs = Math.round(performance.now() - started);
  const denied = await client.callTool({
    name: "files",
    arguments: { op: "read", args: { path: path.join(temp, "outside-allow.txt") } },
  });
  assert.equal(denied.isError, true, "out-of-scope filesystem read succeeded");
  assert.equal(denied.structuredContent?.error?.code, "permission_denied");
  console.log("TETHERPLANE_PORTABLE_DEV_BETA=PASS");
  console.log("SIX_TOOLS=PASS");
  console.log("FIRST_LOCAL_STATUS_MS=" + firstStatusMs);
  console.log("OUTSIDE_ALLOW_FILESYSTEM=DENIED_AS_EXPECTED");
  console.log("REMOTE_AUTHENTICATION=NOT_TESTED");
  console.log("PRODUCTION_CONFIG=UNTOUCHED");
} finally {
  clearTimeout(watchdog);
  await client.close().catch(() => undefined);
  rmSync(temp, { recursive: true, force: true });
}
