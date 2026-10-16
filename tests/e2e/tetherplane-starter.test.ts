import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startLocalCompact } from "./helpers/start-local.ts";

type ExampleCall = {
  name: string;
  arguments: Record<string, unknown>;
};

test("official starter fixture proves local read-only status, schema and policy denial", async () => {
  const currentFile = fileURLToPath(import.meta.url);
  const fixturePath = path.resolve(
    path.dirname(currentFile),
    "../../skills/tetherplane-starter/examples/first-run.json",
  );
  const steps = JSON.parse(await readFile(fixturePath, "utf8")) as ExampleCall[];
  assert.deepEqual(steps.map((step) => step.name), ["device", "device"]);
  assert.deepEqual(
    steps.map((step) => step.arguments.op),
    ["status", "schema"],
  );

  const local = await startLocalCompact();
  try {
    const listed = await local.client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ["batch", "browser", "desktop", "device", "files", "process"],
    );

    for (const step of steps) {
      const result = await local.client.callTool(step);
      assert.equal(result.isError, undefined);
      assert.ok(result.structuredContent, "expected real structured result");
    }

    const denied = await local.client.callTool({
      name: "files",
      arguments: {
        op: "read",
        args: { path: path.resolve(local.root, "..", "outside-allowed-root.txt") },
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      (denied.structuredContent as { error?: { code?: string } } | undefined)?.error?.code,
      "permission_denied",
    );
  } finally {
    await local.close();
  }
});
