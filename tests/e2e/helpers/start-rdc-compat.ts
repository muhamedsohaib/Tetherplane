import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { resolveTetherdPath } from "./resolve-tetherd-path.ts";

function findRepoRoot(startDir: string): string {
  let current = startDir;
  while (current !== path.dirname(current)) {
    if (
      existsSync(path.join(current, "Cargo.toml")) &&
      existsSync(path.join(current, "pnpm-workspace.yaml"))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(startDir, "..", "..", "..");
}

export type RdcCompatHarness = {
  client: Client;
  root: string;
  close(): Promise<void>;
};

export async function startRdcCompat(options: { tetherdPath?: string } = {}): Promise<RdcCompatHarness> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  const root = await mkdtemp(
    path.join(os.tmpdir(), "tetherplane-rdc-e2e-"),
  );
  const tetherdPath = resolveTetherdPath(repoRoot, options.tetherdPath);
  const adapterPath = path.join(
    repoRoot,
    "adapters",
    "rdc-compat",
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
    { name: "tetherplane-rdc-e2e", version: "0.1.0" },
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
