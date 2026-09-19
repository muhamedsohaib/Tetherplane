import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AgentClient } from "../src/agent-client.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgent = path.join(here, "fixtures", "fake-agent.mjs");

function invocation(requestId: string, capability: string) {
  return {
    protocol_version: "1.0" as const,
    request_id: requestId,
    device_id: "Leno",
    capability,
    arguments: {},
    actor: { id: "agent-client-test", kind: "ai_client" as const },
    session_id: null,
    response_mode: "compact" as const,
    idempotency_key: null,
    preconditions: [],
    expectations: [],
  };
}

test("correlates out-of-order JSONL responses by request_id", async () => {
  const client = await AgentClient.spawn({ tetherdPath: fakeAgent });

  try {
    const requestA = invocation(
      "00000000-0000-4000-8000-0000000000a1",
      "device.status",
    );
    const requestB = invocation(
      "00000000-0000-4000-8000-0000000000b2",
      "device.capabilities",
    );

    const promiseA = client.call(requestA);
    const promiseB = client.call(requestB);
    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    assert.equal(resultA.request_id, requestA.request_id);
    assert.equal(resultB.request_id, requestB.request_id);
    assert.deepEqual(resultA.data, { echoed: "device.status" });
    assert.deepEqual(resultB.data, { echoed: "device.capabilities" });
  } finally {
    await client.close();
  }
});

test("disconnect rejects pending and future calls with typed error", async () => {
  const crashAgent = path.join(here, "fixtures", "crash-agent.mjs");
  const client = await AgentClient.spawn({ tetherdPath: crashAgent });

  const requestA = invocation(
    "00000000-0000-4000-8000-0000000000c3",
    "device.status",
  );

  await assert.rejects(client.call(requestA), (error: unknown) => {
    assert.equal(
      (error as { code?: string }).code,
      "disconnected",
    );
    return true;
  });

  const requestB = invocation(
    "00000000-0000-4000-8000-0000000000d4",
    "device.capabilities",
  );

  await assert.rejects(client.call(requestB), (error: unknown) => {
    assert.equal(
      (error as { code?: string }).code,
      "disconnected",
    );
    return true;
  });

  await client.close();
});

test("rejects schema-invalid result envelopes in test mode", async () => {
  const invalidAgent = path.join(
    here,
    "fixtures",
    "invalid-result-agent.mjs",
  );
  const client = await AgentClient.spawn({ tetherdPath: invalidAgent });

  const request = invocation(
    "00000000-0000-4000-8000-0000000000e5",
    "device.status",
  );

  await assert.rejects(client.call(request), (error: unknown) => {
    assert.equal(
      (error as { code?: string }).code,
      "provider_failure",
    );
    return true;
  });

  await client.close();
});
