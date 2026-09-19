import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserOperationalEngine,
  BrowserOwnershipRegistry,
  SemanticSnapshotEngine,
  type BrowserObservedState,
  type BrowserOperationalBackend,
} from "../src/index.ts";

class FakeOperationalBackend implements BrowserOperationalBackend {
  observed: BrowserObservedState = {
    page_id: "page:1",
    url: "https://fixture.example/editor",
    semantic_revision: 10,
    resource_revision: "7",
    nodes: [
      {
        backend_id: "frame:0|css:#upload-input",
        role: "textbox",
        accessible_name: "Fixture upload",
        document_id: "doc-1",
        frame_id: "frame:0",
      },
      {
        backend_id: "frame:0|css:#value-input",
        role: "textbox",
        accessible_name: "Project value",
        value: "draft",
        document_id: "doc-1",
        frame_id: "frame:0",
      },
      {
        backend_id: "frame:0|css:#password",
        role: "textbox",
        accessible_name: "Password",
        sensitive: true,
        document_id: "doc-1",
        frame_id: "frame:0",
      },
    ],
    validation_messages: [],
    toasts: [],
  };
  uploads: Array<{ pageId: string; backendId: string; filePath: string }> = [];
  rawDownloads = [
    {
      backend_id: "chrome:42",
      page_id: "page:1",
      filename: "browser-lab-download.txt",
      local_path: "C:\\Downloads\\browser-lab-download.txt",
      state: "complete" as const,
      bytes_received: 21,
      total_bytes: 21,
    },
  ];
  rawDiagnostics = [
    {
      kind: "console" as const,
      level: "error",
      message: "request failed",
      url: "https://fixture.example/editor",
    },
    {
      kind: "network" as const,
      level: "info",
      message: "Authorization: Bearer SECRET-TOKEN",
      url: "https://fixture.example/api",
      request_headers: {
        Authorization: "Bearer SECRET-TOKEN",
        Cookie: "session=SECRET-COOKIE",
        "Content-Type": "application/json",
      },
    },
  ];

  async observe(): Promise<BrowserObservedState> {
    return structuredClone(this.observed);
  }

  async uploadFile(
    pageId: string,
    backendId: string,
    filePath: string,
  ): Promise<void> {
    this.uploads.push({ pageId, backendId, filePath });
  }

  async downloads() {
    return structuredClone(this.rawDownloads);
  }

  async diagnostics() {
    return structuredClone(this.rawDiagnostics);
  }
}

function setup() {
  const backend = new FakeOperationalBackend();
  const ownership = new BrowserOwnershipRegistry();
  ownership.register({
    page_id: "page:1",
    ownership: "tetherplane",
    active: false,
  });
  const semantics = new SemanticSnapshotEngine();
  const engine = new BrowserOperationalEngine({
    backend,
    ownership,
    semantics,
  });
  return { backend, ownership, semantics, engine };
}

test("native upload resolves semantic target and never invokes a foreground file picker", async () => {
  const { backend, semantics, engine } = setup();
  const snapshot = semantics.snapshot(backend.observed.nodes, {
    revision: backend.observed.semantic_revision,
  });
  const upload = snapshot.nodes.find(
    (node) => node.accessible_name === "Fixture upload",
  );
  assert.ok(upload);

  const result = await engine.upload({
    page_id: "page:1",
    mode: "background_only",
    target: upload.ref,
    file_path: "C:\\fixtures\\upload.txt",
  });

  assert.deepEqual(backend.uploads, [
    {
      pageId: "page:1",
      backendId: "frame:0|css:#upload-input",
      filePath: "C:\\fixtures\\upload.txt",
    },
  ]);
  assert.equal(result.uploaded, true);
  assert.equal(result.page_id, "page:1");
});

test("downloads get stable opaque handles while preserving local path and state", async () => {
  const { engine } = setup();

  const first = await engine.downloads({
    page_id: "page:1",
  });
  const second = await engine.downloads({
    page_id: "page:1",
  });

  assert.equal(first.downloads.length, 1);
  assert.match(first.downloads[0]!.handle, /^download_[0-9a-f]{16}$/);
  assert.equal(
    first.downloads[0]!.local_path,
    "C:\\Downloads\\browser-lab-download.txt",
  );
  assert.equal(first.downloads[0]!.state, "complete");
  assert.equal(second.downloads[0]!.handle, first.downloads[0]!.handle);
  assert.equal(
    JSON.stringify(first).includes("chrome:42"),
    false,
  );
});

test("diagnostics are bounded and redact tokens cookies and authorization values", async () => {
  const { engine } = setup();

  const result = await engine.diagnostics({
    page_id: "page:1",
    limit: 10,
  });
  const encoded = JSON.stringify(result);

  assert.equal(result.events.length, 2);
  assert.equal(encoded.includes("SECRET-TOKEN"), false);
  assert.equal(encoded.includes("SECRET-COOKIE"), false);
  assert.equal(encoded.includes("Authorization"), false);
  assert.equal(encoded.includes("Cookie"), false);
  assert.equal(
    result.events[1]?.request_headers?.["Content-Type"],
    "application/json",
  );
});

test("checkpoint captures safe semantic form state, ownership and revisions without secrets", async () => {
  const { engine } = setup();

  const checkpoint = await engine.checkpoint({
    page_id: "page:1",
    mode: "background_only",
  });

  assert.equal(checkpoint.page_id, "page:1");
  assert.equal(checkpoint.url, "https://fixture.example/editor");
  assert.equal(checkpoint.ownership, "tetherplane");
  assert.equal(checkpoint.semantic_revision, 10);
  assert.equal(checkpoint.resource_revision, "7");
  assert.deepEqual(checkpoint.form_state, [
    {
      role: "textbox",
      accessible_name: "Project value",
      value: "draft",
    },
  ]);
  assert.equal(JSON.stringify(checkpoint).includes("Password"), false);
  assert.equal(JSON.stringify(checkpoint).includes("SECRET"), false);
  assert.match(checkpoint.checkpoint_id, /^checkpoint_[0-9a-f]{16}$/);
});

test("checkpoint resource revision can detect a later conflicting edit", async () => {
  const { backend, engine } = setup();
  const checkpoint = await engine.checkpoint({
    page_id: "page:1",
    mode: "background_only",
  });

  backend.observed.resource_revision = "8";
  const current = await engine.checkpoint({
    page_id: "page:1",
    mode: "background_only",
  });

  assert.notEqual(
    current.resource_revision,
    checkpoint.resource_revision,
  );
});

test("downloads are bounded and report truncation", async () => {
  const { backend, engine } = setup();
  backend.rawDownloads = Array.from({ length: 5 }, (_, index) => ({
    backend_id: `chrome:${index}`,
    page_id: "page:1",
    filename: `download-${index}.txt`,
    local_path: `C:\\Downloads\\download-${index}.txt`,
    state: "complete" as const,
    bytes_received: index + 1,
    total_bytes: index + 1,
  }));

  const result = await engine.downloads({
    page_id: "page:1",
    limit: 2,
  });

  assert.equal(result.downloads.length, 2);
  assert.equal(result.truncated, true);
});
