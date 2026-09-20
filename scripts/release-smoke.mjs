import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseArgs(argv) {
  const values = { tetherd: null, allow: null, stateDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--tetherd" && value) {
      values.tetherd = value;
      index += 1;
    } else if (arg === "--allow" && value) {
      values.allow = value;
      index += 1;
    } else if (arg === "--state-dir" && value) {
      values.stateDir = value;
      index += 1;
    } else {
      throw new Error("unknown or incomplete smoke argument: " + arg);
    }
  }
  if (!values.tetherd || !values.allow) {
    throw new Error("--tetherd and --allow are required");
  }
  return values;
}

const options = parseArgs(process.argv.slice(2));
const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "dist", "stdio-server.js");
const serverArgs = [
  serverPath,
  "--tetherd",
  options.tetherd,
  "--allow",
  options.allow,
];
if (options.stateDir) {
  serverArgs.push("--state-dir", options.stateDir);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: serverArgs,
  cwd: here,
  stderr: "inherit",
});
const client = new Client(
  { name: "tetherplane-release-smoke", version: "0.1.0" },
  { capabilities: {} },
);

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["batch", "browser", "desktop", "device", "files", "process"]);
  process.stdout.write("SIX_TOOL_SMOKE_OK\n");
} finally {
  await client.close().catch(() => undefined);
}
