#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ControlCenterServer } from "./server.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "relay-url": { type: "string" },
      port: { type: "string", default: "8790" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(
      "Tetherplane Control Center\n\nUsage: pnpm --filter @tetherplane/control-center start --relay-url <origin> [--port 8790]\n\nLocal web portal at http://127.0.0.1:8790. No domain or hosting needed.\nUse an existing HTTPS relay origin, or numeric loopback HTTP for development.\nEnter an existing authorized relay access credential in the portal; never pass it on the command line.\n",
    );
    return;
  }
  if (!values["relay-url"] || !/^\d{1,5}$/.test(values.port))
    throw new Error("Invalid options.");
  const portal = new ControlCenterServer({ relayUrl: values["relay-url"] });
  const url = await portal.listen({ port: Number(values.port) });
  process.stdout.write(
    `Tetherplane Control Center: ${url}\nOpen this address in your browser. Press Ctrl+C to stop and clear local sessions.\n`,
  );
  const close = () => {
    void portal.close().then(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
main().catch(() => {
  // Argument parser and URL errors may include credential-bearing input.
  process.stderr.write(
    "Control Center could not start. Check --help, the relay origin and local port.\n",
  );
  process.exitCode = 1;
});
