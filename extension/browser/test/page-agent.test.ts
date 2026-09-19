import assert from "node:assert/strict";
import test from "node:test";

import {
  ChromePageAgent,
  type ChromeScriptingApi,
} from "../src/page-agent.ts";

class FakeController {
  readonly page = {
    page_id: "tab:7",
    tab_id: 7,
    window_id: 1,
    url: "https://fixture.example/editor",
    active: false,
    ownership: "tetherplane" as const,
  };
  navigations: Array<{ pageId: string; url: string }> = [];

  pages() {
    return [structuredClone(this.page)];
  }

  async navigate(pageId: string, url: string) {
    this.navigations.push({ pageId, url });
    return {
      ...structuredClone(this.page),
      page_id: pageId,
      url,
    };
  }
}

class FakeScripting implements ChromeScriptingApi {
  readonly calls: Array<Record<string, unknown>> = [];
  nextResults: Array<{
    frameId: number;
    documentId?: string;
    result?: unknown;
  }> = [];

  async executeScript(
    injection: Record<string, unknown>,
  ): Promise<
    Array<{
      frameId: number;
      documentId?: string;
      result?: unknown;
    }>
  > {
    this.calls.push(injection);
    return structuredClone(this.nextResults);
  }
}

test("Chrome page agent aggregates frame-aware semantic observation", async () => {
  const controller = new FakeController();
  const scripting = new FakeScripting();
  scripting.nextResults = [
    {
      frameId: 0,
      documentId: "document-top",
      result: {
        url: "https://fixture.example/editor",
        semantic_revision: 9,
        resource_revision: "4",
        nodes: [
          {
            backend_id: "css:#value-input",
            role: "textbox",
            accessible_name: "Project value",
            value: "visible",
          },
        ],
        validation_messages: [],
        toasts: ["Saved"],
      },
    },
    {
      frameId: 2,
      documentId: "document-frame",
      result: {
        url: "https://fixture.example/frame",
        semantic_revision: 3,
        resource_revision: null,
        nodes: [
          {
            backend_id: "css:#frame-action",
            role: "button",
            accessible_name: "Frame action",
          },
        ],
        validation_messages: [],
        toasts: [],
      },
    },
  ];

  const agent = new ChromePageAgent({ controller, scripting });
  const observed = await agent.observe("tab:7");

  assert.equal(observed.page_id, "tab:7");
  assert.equal(observed.url, "https://fixture.example/editor");
  assert.equal(observed.semantic_revision, 9);
  assert.equal(observed.resource_revision, "4");
  assert.equal(observed.nodes.length, 2);
  assert.equal(
    observed.nodes[0]?.backend_id,
    "frame:0|css:#value-input",
  );
  assert.equal(observed.nodes[0]?.document_id, "document-top");
  assert.equal(observed.nodes[0]?.frame_id, "frame:0");
  assert.equal(
    observed.nodes[1]?.backend_id,
    "frame:2|css:#frame-action",
  );
  assert.deepEqual(observed.toasts, ["Saved"]);
});

test("Chrome page agent performs semantic action in encoded target frame", async () => {
  const controller = new FakeController();
  const scripting = new FakeScripting();
  scripting.nextResults = [
    {
      frameId: 2,
      result: { ok: true },
    },
  ];
  const agent = new ChromePageAgent({ controller, scripting });

  await agent.perform("tab:7", {
    kind: "fill",
    backend_id: "frame:2|css:#value-input",
    value: "updated",
  });

  assert.equal(scripting.calls.length, 1);
  assert.deepEqual(scripting.calls[0]?.target, {
    tabId: 7,
    frameIds: [2],
  });
  assert.deepEqual(scripting.calls[0]?.args, [
    "css:#value-input",
    {
      kind: "fill",
      backend_id: "frame:2|css:#value-input",
      value: "updated",
    },
  ]);
});

test("Chrome page agent routes navigation through ownership-aware controller", async () => {
  const controller = new FakeController();
  const scripting = new FakeScripting();
  const agent = new ChromePageAgent({ controller, scripting });

  await agent.perform("tab:7", {
    kind: "navigate",
    url: "https://fixture.example/next",
  });

  assert.deepEqual(controller.navigations, [
    {
      pageId: "tab:7",
      url: "https://fixture.example/next",
    },
  ]);
  assert.equal(scripting.calls.length, 0);
});

test("Chrome page agent surfaces missing page and stale target as machine-readable errors", async () => {
  const controller = new FakeController();
  const scripting = new FakeScripting();
  const agent = new ChromePageAgent({ controller, scripting });

  await assert.rejects(
    () => agent.observe("tab:404"),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "invalid_arguments",
  );

  scripting.nextResults = [
    {
      frameId: 0,
      result: {
        ok: false,
        code: "stale_reference",
        message: "target no longer exists",
      },
    },
  ];
  await assert.rejects(
    () =>
      agent.perform("tab:7", {
        kind: "click",
        backend_id: "frame:0|css:#missing",
      }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: unknown }).code === "stale_reference",
  );
});
