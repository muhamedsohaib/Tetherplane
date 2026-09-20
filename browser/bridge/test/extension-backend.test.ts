import assert from "node:assert/strict";
import test from "node:test";

import {
  ExtensionBrowserBackend,
  ExtensionBackendError,
  type ExtensionCommandTransport,
} from "../src/index.ts";

class FakeTransport implements ExtensionCommandTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly queued: Array<Record<string, unknown>> = [];
  readonly waiters: Array<
    (message: Record<string, unknown>) => void
  > = [];

  send(message: Record<string, unknown>): void {
    this.sent.push(structuredClone(message));
  }

  nextMessage(): Promise<Record<string, unknown>> {
    const queued = this.queued.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  push(message: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(structuredClone(message));
      return;
    }
    this.queued.push(structuredClone(message));
  }
}

function success(
  requestId: string,
  data: unknown,
): Record<string, unknown> {
  return {
    type: "result",
    request_id: requestId,
    status: "success",
    data,
  };
}

test("extension backend correlates out-of-order semantic observations", async () => {
  const transport = new FakeTransport();
  const backend = new ExtensionBrowserBackend({ transport });

  const first = backend.observe("tab:1");
  const second = backend.observe("tab:2");

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(transport.sent.length, 2);
  const firstId = String(transport.sent[0]?.request_id);
  const secondId = String(transport.sent[1]?.request_id);

  transport.push(
    success(secondId, {
      page_id: "tab:2",
      url: "https://fixture.example/two",
      semantic_revision: 2,
      resource_revision: null,
      nodes: [],
      validation_messages: [],
      toasts: [],
    }),
  );
  transport.push(
    success(firstId, {
      page_id: "tab:1",
      url: "https://fixture.example/one",
      semantic_revision: 1,
      resource_revision: null,
      nodes: [],
      validation_messages: [],
      toasts: [],
    }),
  );

  assert.equal((await first).page_id, "tab:1");
  assert.equal((await second).page_id, "tab:2");
});

test("extension backend message pump goes idle after the last pending command", async () => {
  const transport = new FakeTransport();
  const backend = new ExtensionBrowserBackend({ transport });

  const observing = backend.observe("tab:idle");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const requestId = String(transport.sent[0]?.request_id);
  transport.push(
    success(requestId, {
      page_id: "tab:idle",
      url: "https://fixture.example/idle",
      semantic_revision: 1,
      resource_revision: null,
      nodes: [],
      validation_messages: [],
      toasts: [],
    }),
  );

  await observing;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(transport.waiters.length, 0);
});

test("extension backend perform preserves machine-readable extension error", async () => {
  const transport = new FakeTransport();
  const backend = new ExtensionBrowserBackend({ transport });

  const performing = backend.perform("tab:1", {
    kind: "fill",
    backend_id: "frame:0|css:#value-input",
    value: "updated",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const requestId = String(transport.sent[0]?.request_id);
  transport.push({
    type: "result",
    request_id: requestId,
    status: "error",
    error: {
      code: "permission_denied",
      message: "human tab mutation denied",
    },
  });

  await assert.rejects(
    () => performing,
    (error: unknown) =>
      error instanceof ExtensionBackendError &&
      error.code === "permission_denied",
  );
});

test("extension backend semantic wait polls until revision changes", async () => {
  const transport = new FakeTransport();
  const backend = new ExtensionBrowserBackend({
    transport,
    pollIntervalMs: 1,
  });

  const waiting = backend.waitForSettled("tab:7", 4, 100);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const firstId = String(transport.sent[0]?.request_id);
  transport.push(
    success(firstId, {
      page_id: "tab:7",
      url: "https://fixture.example/",
      semantic_revision: 4,
      resource_revision: "1",
      nodes: [],
      validation_messages: [],
      toasts: [],
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondId = String(transport.sent[1]?.request_id);
  transport.push(
    success(secondId, {
      page_id: "tab:7",
      url: "https://fixture.example/",
      semantic_revision: 5,
      resource_revision: "2",
      nodes: [],
      validation_messages: [],
      toasts: ["Saved"],
    }),
  );

  const settled = await waiting;
  assert.equal(settled.semantic_revision, 5);
  assert.equal(settled.resource_revision, "2");
});

test("extension backend exposes owned-tab lifecycle commands without activating pages", async () => {
  const transport = new FakeTransport();
  const backend = new ExtensionBrowserBackend({ transport });

  const creating = backend.createTab(
    "https://fixture.example/editor",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const requestId = String(transport.sent[0]?.request_id);
  assert.deepEqual(transport.sent[0]?.args, {
    url: "https://fixture.example/editor",
  });
  transport.push(
    success(requestId, {
      page_id: "tab:8",
      tab_id: 8,
      active: false,
      ownership: "tetherplane",
      url: "https://fixture.example/editor",
    }),
  );

  const page = await creating;
  assert.equal(page.active, false);
  assert.equal(page.ownership, "tetherplane");
});

test("extension backend exposes operational upload downloads and diagnostics commands", async () => {
  const transport = new FakeTransport();
  const backend = new ExtensionBrowserBackend({ transport });

  const upload = backend.uploadFile(
    "tab:7",
    "frame:0|css:#upload-input",
    "C:\\fixtures\\upload.txt",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const uploadId = String(transport.sent[0]?.request_id);
  assert.deepEqual(transport.sent[0]?.args, {
    page_id: "tab:7",
    backend_id: "frame:0|css:#upload-input",
    file_path: "C:\\fixtures\\upload.txt",
  });
  transport.push(success(uploadId, { uploaded: true }));
  await upload;

  const downloads = backend.downloads("tab:7");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const downloadsId = String(transport.sent[1]?.request_id);
  transport.push(
    success(downloadsId, {
      downloads: [
        {
          backend_id: "chrome:42",
          page_id: "tab:7",
          filename: "file.txt",
          local_path: "C:\\Downloads\\file.txt",
          state: "complete",
          bytes_received: 4,
          total_bytes: 4,
        },
      ],
    }),
  );
  assert.equal((await downloads)[0]?.backend_id, "chrome:42");

  const diagnostics = backend.diagnostics("tab:7", 10);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const diagnosticsId = String(transport.sent[2]?.request_id);
  transport.push(
    success(diagnosticsId, {
      events: [
        {
          kind: "console",
          level: "error",
          message: "failure",
        },
      ],
    }),
  );
  assert.deepEqual(await diagnostics, [
    {
      kind: "console",
      level: "error",
      message: "failure",
    },
  ]);
});
