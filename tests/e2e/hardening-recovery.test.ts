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

test("restricted process run denies fail-closed without minting a handle", async () => {
  const local = await startLocalCompact();

  try {
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

    const denied = await call(local.client, "process", {
      op: "run",
      args: processArgs,
    });
    assert.equal(denied.isError, true, "restricted process run must fail closed");
    const body = structured(denied);
    assert.equal(
      (body.error as Record<string, unknown>).code,
      "capability_unavailable",
    );
    assert.equal(body.handle, undefined, "denied run must not mint a handle");
    // Positive runtime-scoped handle coverage (spawn, agent restart,
    // stale-handle rejection) returns when a verified isolation backend is
    // commissioned (containment Task 7).
  } finally {
    await local.close();
  }
});
