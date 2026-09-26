import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

export type LocalCompactHarness = {
  client: Client;
  root: string;
  close(): Promise<void>;
};

export type LocalCompactOptions = {
  principalProfile?: {
    principal_id: string;
    authentication: "local_process_binding";
    allowed_devices: string[];
    allowed_capabilities: string[];
    allowed_roots?: string[];
  };
  stateDir?: string;
  browserBridge?: {
    address: string;
    token: string;
  };
  tetherdPath?: string;
};

export async function startLocalCompact(
  options: LocalCompactOptions = {},
): Promise<LocalCompactHarness> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  const root = await mkdtemp(path.join(os.tmpdir(), "tetherplane-e2e-"));
  const controlRoot = await mkdtemp(
    path.join(os.tmpdir(), "tetherplane-e2e-control-"),
  );
  const executable = process.platform === "win32" ? "tetherd.exe" : "tetherd";
  const tetherdPath = resolveTetherdPath(repoRoot, options.tetherdPath);
  const adapterPath = path.join(
    repoRoot,
    "adapters",
    "compact-mcp",
    "dist",
    "stdio-server.js",
  );

  const adapterArgs = [
    adapterPath,
    "--tetherd",
    tetherdPath,
    "--allow",
    root,
  ];
  if (options.principalProfile) {
    const profilePath = path.join(controlRoot, "principal-profile.json");
    const profile = {
      ...options.principalProfile,
      allowed_roots: options.principalProfile.allowed_roots ?? [root],
    };
    await writeFile(profilePath, JSON.stringify(profile, null, 2), "utf8");
    adapterArgs.push("--principal-profile", profilePath);
  }
  if (options.stateDir) {
    adapterArgs.push("--state-dir", options.stateDir);
  }
  if (options.browserBridge) {
    const tokenPath = path.join(controlRoot, "browser-bridge-token.txt");
    await writeFile(tokenPath, options.browserBridge.token, "utf8");
    adapterArgs.push(
      "--browser-bridge",
      options.browserBridge.address,
      "--browser-bridge-token-file",
      tokenPath,
    );
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: adapterArgs,
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
    await rm(controlRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    client,
    root,
    async close() {
      await client.close();
      await rm(root, { recursive: true, force: true });
      await rm(controlRoot, { recursive: true, force: true });
    },
  };
}
