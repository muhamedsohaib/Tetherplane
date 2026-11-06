import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionCommandRuntime,
  type ExtensionRuntimeSession,
} from "../src/runtime.ts";

type Message = Record<string, unknown>;

class BufferedSession implements ExtensionRuntimeSession {
  readonly sent: Message[] = [];
  readonly #inbound: Message[] = [];
  readonly #waiters: Array<{
    resolve(message: Message): void;
    reject(error: Error): void;
  }> = [];
  #closed = false;

  send(message: Message): void {
    if (this.#closed) throw new Error("socket closed");
    this.sent.push(structuredClone(message));
  }
  nextMessage(): Promise<Message> {
    const message = this.#inbound.shift();
    if (message) return Promise.resolve(message);
    if (this.#closed) return Promise.reject(new Error("socket closed"));
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
  push(message: Message): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(message);
    else this.#inbound.push(message);
  }
  disconnect(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(new Error("socket closed"));
    }
  }
}

const command = (requestId: string, operation: string, args: Message = {}) =>
  ({ type: "command", request_id: requestId, operation, args });

async function until(predicate: () => boolean, deadlineMs = 500): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("hung observe does not block grant-filtered pages; mutations are not queued", async () => {
  const session = new BufferedSession();
  let releaseObserve!: (value: unknown) => void;
  let observeStarted = false;
  let mutateCalls = 0;
  const observe = new Promise<unknown>(resolve => { releaseObserve = resolve; });
  const runtime = new ExtensionCommandRuntime({
    session,
    controller: {
      pages: () => [
        { page_id: "tab:1", tab_id: 1, active: true,
          ownership: "shared-authorized", url: "https://example.com/" },
        { page_id: "tab:2", tab_id: 2, active: true,
          ownership: "human", url: "https://private.invalid/" },
      ],
      createOwnedTab: async () => ({}),
      navigate: async () => ({}),
      close: async () => undefined,
    },
    pageAgent: {
      observe: async () => {
        observeStarted = true;
        return observe;
      },
      perform: async () => { mutateCalls++; },
    },
  });

  const serving = runtime.run();
  session.push(command("slow-observe", "observe", { page_id: "tab:1" }));
  await until(() => observeStarted);

  session.push(command("list", "pages"));
  await until(() => session.sent.some(x => x.request_id === "list"));
  const list = session.sent.find(x => x.request_id === "list");
  assert.deepEqual(list?.data, {
    pages: [{ page_id: "tab:1", tab_id: 1, active: true,
      ownership: "shared-authorized", url: "https://example.com/" }],
  });

  session.push(command("mutate-while-busy", "perform", {
    page_id: "tab:1", action: { kind: "click", backend_id: "#ok" },
  }));
  await until(() => session.sent.some(x => x.request_id === "mutate-while-busy"));
  assert.equal(mutateCalls, 0);
  assert.deepEqual(
    session.sent.find(x => x.request_id === "mutate-while-busy")?.error,
    { code: "provider_busy", message: "another browser command is still in progress" },
  );

  releaseObserve({
    page_id: "tab:1", url: "https://example.com/",
    semantic_revision: 1, nodes: [], validation_messages: [], toasts: [],
  });
  await until(() => session.sent.some(x => x.request_id === "slow-observe"));

  // The current backend must not process a previously rejected mutation later.
  assert.equal(mutateCalls, 0);
  session.disconnect();
  await serving;
});

test("run exits cleanly on disconnected extension socket", async () => {
  const session = new BufferedSession();
  const runtime = new ExtensionCommandRuntime({
    session,
    controller: {
      pages: () => [],
      createOwnedTab: async () => ({}),
      navigate: async () => ({}),
      close: async () => undefined,
    },
    pageAgent: { observe: async () => ({}), perform: async () => undefined },
  });
  const serving = runtime.run();
  session.disconnect();
  await serving;
  assert.deepEqual(session.sent, []);
});


test("a hung read-only snapshot expires without blocking later observations", async () => {
  const session = new BufferedSession();
  let calls = 0;
  let releaseFirst!: (value: unknown) => void;
  const never = new Promise<unknown>(resolve => { releaseFirst = resolve; });
  const fixtureState = {
    page_id: "tab:7", url: "https://fixture.example/",
    semantic_revision: 1, nodes: [], validation_messages: [], toasts: [],
  };
  const runtime = new ExtensionCommandRuntime({
    session,
    observeTimeoutMs: 40,
    controller: {
      pages: () => [{
        page_id: "tab:7", tab_id: 7, active: true,
        ownership: "shared-authorized", url: "https://fixture.example/",
      }],
      createOwnedTab: async () => ({}),
      navigate: async () => ({}),
      close: async () => undefined,
    },
    pageAgent: {
      observe: async () => {
        calls++;
        return calls === 1 ? never : fixtureState;
      },
      perform: async () => undefined,
    },
  });
  const run = runtime.run();
  try {
    session.push(command("hung", "observe", { page_id: "tab:7" }));
    await until(() => calls === 1);
    await until(() => session.sent.some(m => m.request_id === "hung"));
    const timedOut = session.sent.find(m => m.request_id === "hung");
    assert.equal(timedOut?.status, "error");
    assert.equal((timedOut?.error as { code?: string })?.code, "timeout");

    // A separate read after timeout can proceed. The old observation is
    // uncancelled, so it remains counted against the concurrency ceiling.
    session.push(command("healthy", "observe", { page_id: "tab:7" }));
    await until(() => session.sent.some(m => m.request_id === "healthy"));
    assert.equal(session.sent.find(m => m.request_id === "healthy")?.status, "success");
    assert.equal(calls, 2);

    session.push(command("check-pages", "pages"));
    await until(() => session.sent.some(m => m.request_id === "check-pages"));
    assert.equal(session.sent.find(m => m.request_id === "check-pages")?.status, "success");
  } finally {
    releaseFirst(fixtureState);
    session.disconnect();
    await run;
  }
});

test("at most two underlying browser observations can remain unresolved", async () => {
  const session = new BufferedSession();
  let calls = 0;
  const releases: Array<() => void> = [];
  const runtime = new ExtensionCommandRuntime({
    session,
    observeTimeoutMs: 35,
    controller: {
      pages: () => [],
      createOwnedTab: async () => ({}),
      navigate: async () => ({}),
      close: async () => undefined,
    },
    pageAgent: {
      observe: async () => {
        calls++;
        return new Promise(resolve => releases.push(() => resolve({ nodes: [] })));
      },
      perform: async () => undefined,
    },
  });
  const run = runtime.run();
  try {
    for (const id of ["first", "second", "third"]) {
      session.push(command(id, "observe", { page_id: "tab:1" }));
      await until(() => session.sent.some(m => m.request_id === id));
    }
    assert.equal(calls, 2);
    const last = session.sent.find(m => m.request_id === "third");
    assert.equal(last?.status, "error");
    assert.equal((last?.error as { code?: string })?.code, "provider_busy");
  } finally {
    for (const release of releases) release();
    session.disconnect();
    await run;
  }
});

test("observation deadline validates the configured maximum", () => {
  const make = (observeTimeoutMs: number) => new ExtensionCommandRuntime({
    session: new BufferedSession(),
    observeTimeoutMs,
    controller: {
      pages: () => [],
      createOwnedTab: async () => ({}),
      navigate: async () => ({}),
      close: async () => undefined,
    },
    pageAgent: { observe: async () => ({}), perform: async () => undefined },
  });
  assert.throws(() => make(0), /observe timeout/);
  assert.throws(() => make(Number.POSITIVE_INFINITY), /observe timeout/);
  assert.throws(() => make(30_001), /observe timeout/);
});
