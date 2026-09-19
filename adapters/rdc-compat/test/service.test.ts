import assert from "node:assert/strict";
import test from "node:test";

import type {
  InvocationEnvelope,
  ResultEnvelope,
} from "@tetherplane/protocol";

import { RdcCompatibilityService } from "../src/service.ts";

class FakeAgent {
  readonly calls: InvocationEnvelope[] = [];
  searchReads = 0;
  processMutations = 0;

  async call(
    invocation: InvocationEnvelope,
  ): Promise<ResultEnvelope> {
    this.calls.push(structuredClone(invocation));
    const capability = invocation.capability;

    if (capability === "search.start") {
      return success(invocation, {
        handle: "search_alpha",
        state: "running",
      });
    }
    if (capability === "search.read") {
      this.searchReads += 1;
      return success(invocation, {
        handle: "search_alpha",
        matches:
          this.searchReads === 1
            ? [
                { path: "a.txt", kind: "filename" },
                { path: "b.txt", kind: "filename" },
                { path: "c.txt", kind: "filename" },
              ]
            : [{ path: "d.txt", kind: "filename" }],
        state: this.searchReads >= 2 ? "completed" : "running",
        done: this.searchReads >= 2,
      });
    }
    if (capability === "search.list") {
      return success(invocation, {
        sessions: [
          {
            handle: "search_alpha",
            state: "completed",
            queued: 0,
            queue_capacity: 128,
          },
        ],
      });
    }
    if (capability === "process.run") {
      this.processMutations += 1;
      return success(invocation, {
        handle: "proc_owned",
        pid: 4321,
        running: true,
        stdout: "ready\n",
        stderr: "",
      });
    }
    if (capability === "process.read") {
      return success(invocation, {
        handle: "proc_owned",
        running: true,
        stdout: "next\n",
        stderr: "",
      });
    }
    if (capability === "process.input") {
      this.processMutations += 1;
      return success(invocation, {
        handle: "proc_owned",
        bytes_written: 5,
      });
    }
    if (capability === "process.terminate") {
      if ("pid" in invocation.arguments) {
        return failure(
          invocation,
          "permission_denied",
          "system PIDs cannot be terminated",
        );
      }
      this.processMutations += 1;
      return success(invocation, {
        handle: "proc_owned",
        running: false,
      });
    }
    if (capability === "process.list_sessions") {
      return success(invocation, {
        sessions: [
          {
            handle: "proc_owned",
            pid: 4321,
            origin: "tetherplane",
            running: true,
          },
        ],
      });
    }
    if (capability === "process.list_system") {
      return success(invocation, {
        processes: [
          { pid: 90, name: "human.exe", origin: "human_or_external" },
        ],
      });
    }

    return success(invocation, { ok: true });
  }
}

test("search compatibility caches canonical unseen results for legacy offsets", async () => {
  const agent = new FakeAgent();
  const service = new RdcCompatibilityService({
    agentClient: agent,
    platform: "win32",
  });

  const started = await service.call("start_search", {
    path: "C:\\sandbox",
    pattern: ".txt",
    searchType: "files",
    literalSearch: true,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(started.data.sessionId, "search_alpha");

  const first = await service.call("get_more_search_results", {
    sessionId: "search_alpha",
    offset: 0,
    length: 2,
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(
    (first.data.results as Array<Record<string, unknown>>).map(
      (item) => item.path,
    ),
    ["a.txt", "b.txt"],
  );

  const second = await service.call("get_more_search_results", {
    sessionId: "search_alpha",
    offset: 2,
    length: 2,
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(
    (second.data.results as Array<Record<string, unknown>>).map(
      (item) => item.path,
    ),
    ["c.txt", "d.txt"],
  );
  assert.equal(agent.searchReads, 2);
});

test("legacy process IDs are synthetic and resolve only to owned canonical handles", async () => {
  const agent = new FakeAgent();
  const service = new RdcCompatibilityService({
    agentClient: agent,
    platform: "win32",
  });

  const started = await service.call("start_process", {
    command: "echo ready",
    timeout_ms: 250,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(typeof started.data.pid, "number");
  assert.notEqual(started.data.pid, 4321);

  const compatPid = started.data.pid as number;
  const run = agent.calls.find(
    (call) => call.capability === "process.run",
  );
  assert.deepEqual(run?.arguments, {
    program: "cmd.exe",
    args: ["/C", "echo ready"],
    wait_ms: 250,
    pty: true,
  });

  const read = await service.call("read_process_output", {
    pid: compatPid,
    offset: 0,
    length: 100,
    timeout_ms: 50,
  });
  assert.equal(read.ok, true);
  assert.equal(
    agent.calls.at(-1)?.arguments.handle,
    "proc_owned",
  );

  const interacted = await service.call(
    "interact_with_process",
    {
      pid: compatPid,
      input: "hello",
      timeout_ms: 25,
      wait_for_prompt: false,
    },
  );
  assert.equal(interacted.ok, true);
  const inputCall = agent.calls.find(
    (call) => call.capability === "process.input",
  );
  assert.equal(inputCall?.arguments.data, "hello\r\n");

  const terminated = await service.call("force_terminate", {
    pid: compatPid,
  });
  assert.equal(terminated.ok, true);
  assert.equal(
    agent.calls.at(-1)?.arguments.handle,
    "proc_owned",
  );
});

test("legacy kill_process cannot turn an arbitrary system pid into owned authority", async () => {
  const agent = new FakeAgent();
  const service = new RdcCompatibilityService({
    agentClient: agent,
    platform: "win32",
  });

  const result = await service.call("kill_process", { pid: 90 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "permission_denied");
  assert.equal(
    agent.calls.at(-1)?.capability,
    "process.terminate",
  );
  assert.deepEqual(agent.calls.at(-1)?.arguments, { pid: 90 });
});

function success(
  invocation: InvocationEnvelope,
  data: Record<string, unknown>,
): ResultEnvelope {
  return {
    protocol_version: "1.0",
    request_id: invocation.request_id,
    status: "success",
    data,
    delta: null,
    error: null,
    verification: "not_applicable",
    continuation: null,
    policy: null,
    timing: { duration_ms: 0 },
  };
}

function failure(
  invocation: InvocationEnvelope,
  code: "permission_denied",
  message: string,
): ResultEnvelope {
  return {
    protocol_version: "1.0",
    request_id: invocation.request_id,
    status: "error",
    data: null,
    delta: null,
    error: {
      code,
      message,
      recovery_hint: null,
      details: {},
    },
    verification: "failed",
    continuation: null,
    policy: null,
    timing: { duration_ms: 0 },
  };
}
