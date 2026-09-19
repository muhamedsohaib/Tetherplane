import assert from "node:assert/strict";
import test from "node:test";

import { translateCompactCall } from "../src/translate.ts";

const mappings = [
  ["files", "read", "filesystem.read"],
  ["files", "search", "search.start"],
  ["files", "search_read", "search.read"],
  ["process", "run", "process.run"],
  ["device", "status", "device.status"],
  ["browser", "inspect", "browser.inspect"],
  ["desktop", "observe", "desktop.observe"],
  ["batch", "execute", "batch.execute"],
] as const;

test("maps compact tool operations to canonical capabilities", () => {
  for (const [tool, op, capability] of mappings) {
    const invocation = translateCompactCall(
      tool,
      { op, args: { marker: capability } },
      { sessionId: "session-11" },
    );

    assert.equal(invocation.capability, capability);
    assert.deepEqual(invocation.arguments, { marker: capability });
  }
});

test("constructs canonical invocation defaults and forwards common fields", () => {
  const invocation = translateCompactCall(
    "process",
    {
      op: "run",
      args: { program: "example" },
      response_mode: "debug",
      device: "Leno",
      idempotency_key: "idem-11",
    },
    { sessionId: "mcp-session-11" },
  );

  assert.match(
    invocation.request_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.deepEqual(invocation.actor, {
    id: "compact-mcp",
    kind: "ai_client",
  });
  assert.equal(invocation.session_id, "mcp-session-11");
  assert.equal(invocation.device_id, "Leno");
  assert.equal(invocation.response_mode, "debug");
  assert.equal(invocation.idempotency_key, "idem-11");
  assert.deepEqual(invocation.preconditions, []);
  assert.deepEqual(invocation.expectations, []);
});

test("defaults optional envelope fields for compact calls", () => {
  const invocation = translateCompactCall("device", {
    op: "status",
  });

  assert.equal(invocation.response_mode, "compact");
  assert.equal(invocation.device_id, null);
  assert.equal(invocation.session_id, null);
  assert.equal(invocation.idempotency_key, null);
  assert.deepEqual(invocation.arguments, {});
});
