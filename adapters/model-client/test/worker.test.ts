import assert from "node:assert/strict";
import test from "node:test";

import type { InvocationEnvelope, ResultEnvelope } from "@tetherplane/protocol";

import {
  ModelActionError,
  TetherplaneModelWorker,
  type ModelAction,
  type ModelActionSource,
} from "../src/index.ts";

function result(
  requestId: string,
  data: unknown,
  status: "success" | "error" = "success",
  error: ResultEnvelope["error"] = null,
): ResultEnvelope {
  return {
    protocol_version: "1.0",
    request_id: requestId,
    status,
    data,
    delta: null,
    error,
    verification: status === "success" ? "verified" : "not_applicable",
    continuation: null,
    policy: null,
    timing: { duration_ms: 1 },
  };
}

class FakeModel implements ModelActionSource {
  readonly calls: Array<{ objective: string; context?: Record<string, unknown> }> = [];
  readonly #actions: Array<ModelAction | Error>;

  constructor(actions: Array<ModelAction | Error>) {
    this.#actions = [...actions];
  }

  async nextAction(input: {
    objective: string;
    context?: Record<string, unknown>;
  }): Promise<ModelAction> {
    this.calls.push(input);
    const next = this.#actions.shift();
    if (!next) throw new Error("fake model action queue exhausted");
    if (next instanceof Error) throw next;
    return next;
  }
}

class FakeAgent {
  readonly calls: InvocationEnvelope[] = [];
  readonly #handler: (invocation: InvocationEnvelope) => ResultEnvelope;

  constructor(handler: (invocation: InvocationEnvelope) => ResultEnvelope) {
    this.#handler = handler;
  }

  async call(invocation: InvocationEnvelope): Promise<ResultEnvelope> {
    this.calls.push(invocation);
    return this.#handler(invocation);
  }
}

const job = {
  job_id: "job_0123456789abcdef0123456789abcdef",
  objective: "create a bounded artifact",
  target_device: "Leno",
  creator_principal: "human:owner",
  permitted_principals: ["human:owner", "model:engineer"],
  status: "active",
  latest_checkpoint: null,
  active_lease: null,
  created_at_unix_ms: 1,
  updated_at_unix_ms: 1,
};

function leaseJob() {
  return {
    ...job,
    active_lease: {
      lease_id: "lease_0123456789abcdef0123456789abcdef",
      principal_id: "model:engineer",
      expires_at_unix_ms: Date.now() + 60_000,
    },
  };
}

test("worker stays idle without calling the model when no accessible jobs exist", async () => {
  const model = new FakeModel([]);
  const agent = new FakeAgent((invocation) => {
    assert.equal(invocation.capability, "job.list");
    return result(invocation.request_id, { jobs: [] });
  });
  const worker = new TetherplaneModelWorker({
    model,
    agent,
    device: "Leno",
  });

  const outcome = await worker.runOnce();

  assert.deepEqual(outcome, { status: "idle" });
  assert.equal(model.calls.length, 0);
  assert.equal(agent.calls.length, 1);
  assert.equal(agent.calls[0]?.device_id, "Leno");
  assert.deepEqual(agent.calls[0]?.arguments, {
    status: "active",
    unleased: true,
    limit: 1,
  });
});

test("worker leases one job, pins model actions to it, checkpoints completion, and releases", async () => {
  const model = new FakeModel([
    {
      capability: "filesystem.write",
      arguments: { path: "artifact.txt", content: "done\n" },
    },
    {
      capability: "job.checkpoint",
      arguments: {
        state: { step: "artifact_created", artifacts: ["artifact.txt"] },
        status: "completed",
      },
    },
  ]);
  const agent = new FakeAgent((invocation) => {
    switch (invocation.capability) {
      case "job.list":
        return result(invocation.request_id, { jobs: [job] });
      case "job.acquire_lease":
        return result(invocation.request_id, leaseJob());
      case "filesystem.write":
        return result(invocation.request_id, { path: "artifact.txt" });
      case "job.checkpoint":
        return result(invocation.request_id, {
          ...leaseJob(),
          status: "completed",
          latest_checkpoint: {
            checkpoint_id: "checkpoint_1",
            principal_id: "model:engineer",
            state: invocation.arguments.state,
            created_at_unix_ms: 2,
          },
        });
      case "job.release_lease":
        return result(invocation.request_id, {
          ...job,
          status: "completed",
          active_lease: null,
        });
      default:
        throw new Error(`unexpected capability ${invocation.capability}`);
    }
  });
  const worker = new TetherplaneModelWorker({
    model,
    agent,
    device: "Leno",
    maxActions: 8,
    leaseTtlMs: 120_000,
  });

  const outcome = await worker.runOnce();

  assert.deepEqual(outcome, {
    status: "completed",
    job_id: job.job_id,
    actions: 2,
  });
  const write = agent.calls.find((call) => call.capability === "filesystem.write");
  assert.ok(write);
  assert.equal(write.device_id, "Leno");
  assert.equal(write.job_id, job.job_id);
  const checkpoint = agent.calls.find((call) => call.capability === "job.checkpoint");
  assert.ok(checkpoint);
  assert.equal(checkpoint.device_id, "Leno");
  assert.equal(checkpoint.job_id, job.job_id);

  const release = agent.calls.at(-1);
  assert.equal(release?.capability, "job.release_lease");
  assert.deepEqual(release?.arguments, {
    job_id: job.job_id,
    lease_id: "lease_0123456789abcdef0123456789abcdef",
  });
});

test("worker rejects a model attempt to jump to another device and still releases its lease", async () => {
  const model = new FakeModel([
    {
      capability: "filesystem.read",
      arguments: { path: "secret.txt" },
      device: "OtherDevice",
    },
  ]);
  const agent = new FakeAgent((invocation) => {
    if (invocation.capability === "job.list") {
      return result(invocation.request_id, { jobs: [job] });
    }
    if (invocation.capability === "job.acquire_lease") {
      return result(invocation.request_id, leaseJob());
    }
    if (invocation.capability === "job.release_lease") {
      return result(invocation.request_id, { ...job, active_lease: null });
    }
    throw new Error("cross-device action reached the agent");
  });
  const worker = new TetherplaneModelWorker({
    model,
    agent,
    device: "Leno",
  });

  await assert.rejects(
    () => worker.runOnce(),
    (error: unknown) =>
      error instanceof ModelActionError &&
      /different device/i.test(error.message),
  );

  assert.deepEqual(
    agent.calls.map((call) => call.capability),
    ["job.list", "job.acquire_lease", "job.release_lease"],
  );
});

test("worker rejects a model attempt to jump to another job and still releases its lease", async () => {
  const model = new FakeModel([
    {
      capability: "filesystem.read",
      arguments: { path: "artifact.txt" },
      job_id: "job_ffffffffffffffffffffffffffffffff",
    },
  ]);
  const agent = new FakeAgent((invocation) => {
    if (invocation.capability === "job.list") {
      return result(invocation.request_id, { jobs: [job] });
    }
    if (invocation.capability === "job.acquire_lease") {
      return result(invocation.request_id, leaseJob());
    }
    if (invocation.capability === "job.release_lease") {
      return result(invocation.request_id, { ...job, active_lease: null });
    }
    throw new Error("cross-job action reached the agent");
  });
  const worker = new TetherplaneModelWorker({
    model,
    agent,
    device: "Leno",
  });

  await assert.rejects(
    () => worker.runOnce(),
    (error: unknown) =>
      error instanceof ModelActionError &&
      /different job/i.test(error.message),
  );

  assert.deepEqual(
    agent.calls.map((call) => call.capability),
    ["job.list", "job.acquire_lease", "job.release_lease"],
  );
});

test("lease conflict skips the job without invoking the model", async () => {
  const model = new FakeModel([]);
  const agent = new FakeAgent((invocation) => {
    if (invocation.capability === "job.list") {
      return result(invocation.request_id, { jobs: [job] });
    }
    if (invocation.capability === "job.acquire_lease") {
      return result(
        invocation.request_id,
        null,
        "error",
        {
          code: "resource_conflict",
          message: "job already has an active execution lease",
          recovery_hint: null,
          details: {},
        },
      );
    }
    throw new Error("unexpected call after lease conflict");
  });
  const worker = new TetherplaneModelWorker({
    model,
    agent,
    device: "Leno",
  });

  const outcome = await worker.runOnce();

  assert.deepEqual(outcome, {
    status: "contended",
    job_id: job.job_id,
  });
  assert.equal(model.calls.length, 0);
  assert.deepEqual(
    agent.calls.map((call) => call.capability),
    ["job.list", "job.acquire_lease"],
  );
});

test("model failure releases the active lease", async () => {
  const model = new FakeModel([new Error("model unavailable")]);
  const agent = new FakeAgent((invocation) => {
    if (invocation.capability === "job.list") {
      return result(invocation.request_id, { jobs: [job] });
    }
    if (invocation.capability === "job.acquire_lease") {
      return result(invocation.request_id, leaseJob());
    }
    if (invocation.capability === "job.release_lease") {
      return result(invocation.request_id, { ...job, active_lease: null });
    }
    throw new Error("unexpected action");
  });
  const worker = new TetherplaneModelWorker({
    model,
    agent,
    device: "Leno",
  });

  await assert.rejects(() => worker.runOnce(), /model unavailable/);
  assert.equal(agent.calls.at(-1)?.capability, "job.release_lease");
});

test("worker action limit stops runaway model loops and releases the lease", async () => {
  const repeated: ModelAction[] = [
    { capability: "device.status", arguments: {} },
    { capability: "device.status", arguments: {} },
    { capability: "device.status", arguments: {} },
  ];
  const model = new FakeModel(repeated);
  const agent = new FakeAgent((invocation) => {
    if (invocation.capability === "job.list") {
      return result(invocation.request_id, { jobs: [job] });
    }
    if (invocation.capability === "job.acquire_lease") {
      return result(invocation.request_id, leaseJob());
    }
    if (invocation.capability === "device.status") {
      return result(invocation.request_id, { online: true });
    }
    if (invocation.capability === "job.release_lease") {
      return result(invocation.request_id, { ...job, active_lease: null });
    }
    throw new Error(`unexpected capability ${invocation.capability}`);
  });
  const worker = new TetherplaneModelWorker({
    model,
    agent,
    device: "Leno",
    maxActions: 2,
  });

  const outcome = await worker.runOnce();

  assert.deepEqual(outcome, {
    status: "action_limit",
    job_id: job.job_id,
    actions: 2,
  });
  assert.equal(model.calls.length, 2);
  assert.equal(agent.calls.at(-1)?.capability, "job.release_lease");
});

test("model cannot take over job lease operations owned by the worker", async () => {
  const model = new FakeModel([
    {
      capability: "job.release_lease",
      arguments: { job_id: job.job_id },
    },
  ]);
  const agent = new FakeAgent((invocation) => {
    if (invocation.capability === "job.list") {
      return result(invocation.request_id, { jobs: [job] });
    }
    if (invocation.capability === "job.acquire_lease") {
      return result(invocation.request_id, leaseJob());
    }
    if (invocation.capability === "job.release_lease") {
      return result(invocation.request_id, { ...job, active_lease: null });
    }
    throw new Error("model-controlled lease operation reached agent");
  });
  const worker = new TetherplaneModelWorker({
    model,
    agent,
    device: "Leno",
  });

  await assert.rejects(
    () => worker.runOnce(),
    (error: unknown) =>
      error instanceof ModelActionError &&
      /worker-owned job operation/i.test(error.message),
  );
  assert.deepEqual(
    agent.calls.map((call) => call.capability),
    ["job.list", "job.acquire_lease", "job.release_lease"],
  );
});
