import assert from "node:assert/strict";
import test from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { startLocalCompact } from "./helpers/start-local.ts";

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

function structured(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  assert.ok(result.structuredContent, "expected structuredContent");
  return result.structuredContent as Record<string, unknown>;
}

test("process handles are runtime-scoped and cannot rebind after agent restart", async () => {
  let first: Awaited<ReturnType<typeof startLocalCompact>> | undefined;
  let second: Awaited<ReturnType<typeof startLocalCompact>> | undefined;

  try {
    first = await startLocalCompact();
    const processArgs =
      process.platform === "win32"
        ? {
            program: "cmd.exe",
            args: ["/C", "echo old-runtime"],
            wait_ms: 0,
            pty: false,
          }
        : {
            program: "/bin/sh",
            args: ["-c", "printf 'old-runtime\\n'"],
            wait_ms: 0,
            pty: false,
          };

    const started = structured(
      await call(first.client, "process", {
        op: "run",
        args: processArgs,
      }),
    );
    const oldHandle = String(started.handle);
    assert.match(oldHandle, /^proc_/);

    await first.close();
    first = undefined;

    second = await startLocalCompact();
    const stale = await call(second.client, "process", {
      op: "read",
      args: { handle: oldHandle, timeout_ms: 50 },
    });
    assert.equal(stale.isError, true);
    assert.equal(
      (structured(stale).error as Record<string, unknown>).code,
      "invalid_arguments",
    );
  } finally {
    await first?.close().catch(() => undefined);
    await second?.close().catch(() => undefined);
  }
});
