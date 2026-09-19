import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type LocalCompactHarness = {
  client: Client;
  root: string;
  close(): Promise<void>;
};

export async function startLocalCompact(): Promise<LocalCompactHarness> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..", "..");
  const root = await mkdtemp(path.join(os.tmpdir(), "tetherplane-e2e-"));
  const executable = process.platform === "win32" ? "tetherd.exe" : "tetherd";
  const tetherdPath = path.join(repoRoot, "target", "debug", executable);
  const adapterPath = path.join(
    repoRoot,
    "adapters",
    "compact-mcp",
    "dist",
    "stdio-server.js",
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      adapterPath,
      "--tetherd",
      tetherdPath,
      "--allow",
      root,
    ],
    cwd: repoRoot,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "tetherplane-e2e", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    client,
    root,
    async close() {
      await client.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
