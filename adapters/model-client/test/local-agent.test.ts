import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { InvocationEnvelope } from "@tetherplane/protocol";

import { LocalAgentClient } from "../src/index.ts";

function invocation(
  requestId: string,
  tag: string,
  delayMs: number,
): InvocationEnvelope {
  return {
    protocol_version: "1.0",
    request_id: requestId,
    device_id: "Leno",
    principal_id: null,
    job_id: null,
    capability: "device.status",
    arguments: { tag, delay_ms: delayMs },
    actor: { id: "model-client-test", kind: "ai_client" },
    session_id: null,
    response_mode: "compact",
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
}

test("direct JSONL agent client correlates out-of-order results", async () => {
  const fakeAgent = fileURLToPath(
    new URL("./fake-tetherd.mjs", import.meta.url),
  );
  const client = await LocalAgentClient.spawn({
    tetherdPath: fakeAgent,
  });

  try {
    const slow = client.call(
      invocation(
        "00000000-0000-4000-8000-000000000301",
        "slow",
        80,
      ),
    );
    const fast = client.call(
      invocation(
        "00000000-0000-4000-8000-000000000302",
        "fast",
        5,
      ),
    );

    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    assert.equal(slowResult.request_id, "00000000-0000-4000-8000-000000000301");
    assert.equal(fastResult.request_id, "00000000-0000-4000-8000-000000000302");
    assert.equal(
      (slowResult.data as Record<string, unknown>).tag,
      "slow",
    );
    assert.equal(
      (fastResult.data as Record<string, unknown>).tag,
      "fast",
    );
  } finally {
    await client.close();
  }
});
