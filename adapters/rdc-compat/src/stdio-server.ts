import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentClient } from "@tetherplane/compact-mcp";

import { createRdcCompatMcpServer } from "./server.ts";

type CliOptions = {
  tetherdPath: string;
  tetherdArgs: string[];
};

function parseArgs(argv: string[]): CliOptions {
  let tetherdPath: string | undefined;
  const tetherdArgs: string[] = [];
  const passThrough = new Set([
    "--allow",
    "--principal-profile",
    "--state-dir",
    "--browser-bridge",
    "--browser-bridge-token-file",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--tetherd") {
      const value = argv[index + 1];
      if (!value) throw new Error("--tetherd requires a path");
      tetherdPath = value;
      index += 1;
      continue;
    }
    if (passThrough.has(argument ?? "")) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      tetherdArgs.push(argument!, value);
      index += 1;
      continue;
    }
    throw new Error(
      `unknown RDC compatibility argument: ${String(argument)}`,
    );
  }

  if (!tetherdPath) throw new Error("--tetherd is required");
  return { tetherdPath, tetherdArgs };
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
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
  const server = createRdcCompatMcpServer({ agentClient });
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
  const message =
    error instanceof Error ? error.message : String(error);
  console.error(
    `RDC compatibility MCP server failed: ${message}`,
  );
  process.exitCode = 1;
});
