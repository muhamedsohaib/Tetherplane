import assert from "node:assert/strict";
import test from "node:test";

import { BrowserPolicyError } from "@tetherplane/browser-bridge";

import {
  ExtensionCommandRuntime,
  type ExtensionCommandController,
  type ExtensionPageAgent,
  type ExtensionRuntimeSession,
} from "../src/runtime.ts";

class FakeSession implements ExtensionRuntimeSession {
  readonly sent: Array<Record<string, unknown>> = [];

  send(message: Record<string, unknown>): void {
    this.sent.push(structuredClone(message));
  }

  async nextMessage(): Promise<Record<string, unknown>> {
    throw new Error("not used by handleMessage tests");
  }
}

class FakeController implements ExtensionCommandController {
  readonly page = {
    page_id: "tab:7",
    tab_id: 7,
    window_id: 1,
    url: "https://fixture.example/",
    active: false,
    ownership: "tetherplane" as const,
  };
  humanMutationAttempts = 0;

  pages() {
    return [structuredClone(this.page)];
  }

  async createOwnedTab(url: string) {
    return {
      ...structuredClone(this.page),
      page_id: "tab:8",
      tab_id: 8,
      url,
    };
  }

  async navigate(pageId: string, url: string) {
    if (pageId === "tab:1") {
      this.humanMutationAttempts += 1;
      throw new BrowserPolicyError(
        "permission_denied",
        "human tab mutation denied",
      );
    }
    return {
      ...structuredClone(this.page),
      page_id: pageId,
      url,
    };
  }

  async close(pageId: string): Promise<void> {
    if (pageId === "tab:1") {
      this.humanMutationAttempts += 1;
      throw new BrowserPolicyError(
        "permission_denied",
        "human tab mutation denied",
      );
    }
  }

  async attachHumanTab(
    tabId: number,
    grant: { operations: string[] },
  ) {
    return {
      ...structuredClone(this.page),
      page_id: `tab:${tabId}`,
      tab_id: tabId,
      ownership: "shared-authorized" as const,
      grant,
    };
  }

  async detachHumanTab(tabId: number) {
    return {
      ...structuredClone(this.page),
      page_id: `tab:${tabId}`,
      tab_id: tabId,
      ownership: "human" as const,
    };
  }
}

class FakePageAgent implements ExtensionPageAgent {
  observed: string[] = [];
  performed: Array<{
    pageId: string;
    action: Record<string, unknown>;
  }> = [];

  async observe(pageId: string) {
    this.observed.push(pageId);
    return {
      page_id: pageId,
      url: "https://fixture.example/",
      semantic_revision: 4,
      resource_revision: "4",
      nodes: [],
      validation_messages: [],
      toasts: [],
    };
  }

  async perform(
    pageId: string,
    action: Record<string, unknown>,
  ): Promise<void> {
    this.performed.push({
      pageId,
      action: structuredClone(action),
    });
  }
}

function runtime() {
  const session = new FakeSession();
  const controller = new FakeController();
  const pageAgent = new FakePageAgent();
  return {
    session,
    controller,
    pageAgent,
    runtime: new ExtensionCommandRuntime({
      session,
      controller,
      pageAgent,
    }),
  };
}

test("authenticated command runtime returns page metadata", async () => {
  const context = runtime();

  await context.runtime.handleMessage({
    type: "command",
    request_id: "request-pages",
    operation: "pages",
    args: {},
  });

  assert.deepEqual(context.session.sent, [
    {
      type: "result",
      request_id: "request-pages",
      status: "success",
      data: {
        pages: [context.controller.page],
      },
    },
  ]);
});

test("command runtime routes semantic observe and perform to page agent", async () => {
  const context = runtime();

  await context.runtime.handleMessage({
    type: "command",
    request_id: "request-observe",
    operation: "observe",
    args: { page_id: "tab:7" },
  });
  await context.runtime.handleMessage({
    type: "command",
    request_id: "request-perform",
    operation: "perform",
    args: {
      page_id: "tab:7",
      action: {
        kind: "fill",
        backend_id: "frame:0|css:#value-input",
        value: "updated",
      },
    },
  });

  assert.deepEqual(context.pageAgent.observed, ["tab:7"]);
  assert.deepEqual(context.pageAgent.performed, [
    {
      pageId: "tab:7",
      action: {
        kind: "fill",
        backend_id: "frame:0|css:#value-input",
        value: "updated",
      },
    },
  ]);
  assert.equal(context.session.sent[0]?.status, "success");
  assert.equal(context.session.sent[1]?.status, "success");
});

test("command runtime preserves machine-readable ownership denial", async () => {
  const context = runtime();

  await context.runtime.handleMessage({
    type: "command",
    request_id: "request-human-nav",
    operation: "navigate",
    args: {
      page_id: "tab:1",
      url: "https://blocked.example/",
    },
  });

  assert.equal(context.controller.humanMutationAttempts, 1);
  assert.deepEqual(context.session.sent, [
    {
      type: "result",
      request_id: "request-human-nav",
      status: "error",
      error: {
        code: "permission_denied",
        message: "human tab mutation denied",
      },
    },
  ]);
});

test("command runtime rejects malformed and unsupported commands", async () => {
  const context = runtime();

  await context.runtime.handleMessage({
    type: "command",
    request_id: "bad-1",
    operation: "unknown",
    args: {},
  });
  await context.runtime.handleMessage({
    type: "event",
    request_id: "bad-2",
  });

  assert.equal(context.session.sent[0]?.status, "error");
  assert.deepEqual(context.session.sent[0]?.error, {
    code: "capability_unavailable",
    message: "unsupported extension operation: unknown",
  });
  assert.equal(context.session.sent.length, 1);
});

test("command runtime routes upload downloads and diagnostics to operational agent", async () => {
  const session = new FakeSession();
  const controller = new FakeController();
  const pageAgent = new FakePageAgent();
  const calls: Array<Record<string, unknown>> = [];
  const operationalAgent = {
    async uploadFile(
      pageId: string,
      backendId: string,
      filePath: string,
    ) {
      calls.push({
        kind: "upload",
        pageId,
        backendId,
        filePath,
      });
    },
    async downloads(pageId?: string) {
      calls.push({ kind: "downloads", pageId });
      return [
        {
          backend_id: "chrome:1",
          page_id: pageId ?? "browser",
          filename: "file.txt",
          local_path: "C:\\Downloads\\file.txt",
          state: "complete" as const,
          bytes_received: 4,
          total_bytes: 4,
        },
      ];
    },
    async diagnostics(pageId: string, limit: number) {
      calls.push({ kind: "diagnostics", pageId, limit });
      return [
        {
          kind: "console" as const,
          level: "error",
          message: "failure",
        },
      ];
    },
  };
  const runtime = new ExtensionCommandRuntime({
    session,
    controller,
    pageAgent,
    operationalAgent,
  });

  await runtime.handleMessage({
    type: "command",
    request_id: "upload-1",
    operation: "upload",
    args: {
      page_id: "tab:7",
      backend_id: "frame:0|css:#upload-input",
      file_path: "C:\\fixtures\\upload.txt",
    },
  });
  await runtime.handleMessage({
    type: "command",
    request_id: "downloads-1",
    operation: "downloads",
    args: { page_id: "tab:7" },
  });
  await runtime.handleMessage({
    type: "command",
    request_id: "diagnostics-1",
    operation: "diagnostics",
    args: { page_id: "tab:7", limit: 25 },
  });

  assert.deepEqual(calls, [
    {
      kind: "upload",
      pageId: "tab:7",
      backendId: "frame:0|css:#upload-input",
      filePath: "C:\\fixtures\\upload.txt",
    },
    { kind: "downloads", pageId: "tab:7" },
    { kind: "diagnostics", pageId: "tab:7", limit: 25 },
  ]);
  assert.equal(session.sent.length, 3);
  assert.deepEqual(session.sent[1]?.data, {
    downloads: [
      {
        backend_id: "chrome:1",
        page_id: "tab:7",
        filename: "file.txt",
        local_path: "C:\\Downloads\\file.txt",
        state: "complete",
        bytes_received: 4,
        total_bytes: 4,
      },
    ],
  });
  assert.deepEqual(session.sent[2]?.data, {
    events: [
      {
        kind: "console",
        level: "error",
        message: "failure",
      },
    ],
  });
});
