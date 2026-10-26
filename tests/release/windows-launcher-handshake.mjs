import assert from "node:assert/strict";
import process from "node:process";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// This script is copied into the test-owned installed compact MCP directory.
// Its node_modules contain the actual packaged SDK dependencies.
// The target is ONLY the local, isolated Windows CI agent in stdio mode.
function parse(argv) {
  const opts = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || !["--launcher", "--allow", "--state-dir"].includes(key) || opts[key]) {
      throw new Error("invalid argument to Windows launcher smoke: " + String(key));
    }
    opts[key] = value;
  }
  for (const key of ["--launcher", "--allow", "--state-dir"]) {
    assert.ok(opts[key], "missing required argument " + key);
  }
  return opts;
}

const args = parse(process.argv.slice(2));
if (process.platform !== "win32") {
  throw new Error("Windows PowerShell launcher acceptance is Windows-only");
}
if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Launcher smoke is restricted to a disposable GitHub-hosted Windows runner");
}

const transport = new StdioClientTransport({
  command: "powershell.exe",
  args: [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", args["--launcher"],
    "--allow", args["--allow"],
    "--state-dir", args["--state-dir"],
  ],
  cwd: dirname(args["--launcher"]),
  stderr: "inherit",
});
const client = new Client(
  { name: "tetherplane-windows-launcher-smoke", version: "0.1.0" },
  { capabilities: {} },
);
async function bounded(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("PowerShell MCP launch or handshake exceeded " + timeoutMs + "ms")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  await bounded(client.connect(transport), 20000);
  const result = await bounded(client.listTools(), 15000);
  const names = result.tools.map(({ name }) => name).sort();
  assert.deepEqual(names, ["batch", "browser", "desktop", "device", "files", "process"]);
  console.log("WINDOWS_PACKAGED_POWERSHELL_MCP_HANDSHAKE_PASS");
} finally {
  await client.close().catch(() => undefined);
}
