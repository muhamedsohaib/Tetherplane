import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AgentClient } from "./agent-client.ts";
import { createCompactMcpServer } from "./compact-tools.ts";

type CliOptions = {
  tetherdPath: string;
  tetherdArgs: string[];
};

function parseArgs(argv: string[]): CliOptions {
  let tetherdPath: string | undefined;
  const tetherdArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tetherd") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--tetherd requires a path");
      }
      tetherdPath = value;
      index += 1;
      continue;
    }

    if (argument === "--allow") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--allow requires a path");
      }
      tetherdArgs.push("--allow", value);
      index += 1;
      continue;
    }

    if (argument === "--principal-profile") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--principal-profile requires a path");
      }
      tetherdArgs.push("--principal-profile", value);
      index += 1;
      continue;
    }

    if (argument === "--state-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--state-dir requires a path");
      }
      tetherdArgs.push("--state-dir", value);
      index += 1;
      continue;
    }

    if (argument === "--browser-bridge") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--browser-bridge requires a loopback address");
      }
      tetherdArgs.push("--browser-bridge", value);
      index += 1;
      continue;
    }

    if (argument === "--browser-bridge-token-file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--browser-bridge-token-file requires a path");
      }
      tetherdArgs.push("--browser-bridge-token-file", value);
      index += 1;
      continue;
    }

    throw new Error(`unknown compact MCP argument: ${argument}`);
  }

  if (!tetherdPath) {
    throw new Error("--tetherd is required");
  }

  return { tetherdPath, tetherdArgs };
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };

    process.stdin.once("end", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const agentClient = await AgentClient.spawn({
    tetherdPath: options.tetherdPath,
    tetherdArgs: options.tetherdArgs,
  });
  const server = createCompactMcpServer({ agentClient });
  const transport = new StdioServerTransport();

  try {
    await server.connect(transport);
    await waitForShutdown();
  } finally {
    await server.close().catch(() => undefined);
    await agentClient.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`compact MCP server failed: ${message}`);
  process.exitCode = 1;
});
