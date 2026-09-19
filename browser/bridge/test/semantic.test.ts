import assert from "node:assert/strict";
import test from "node:test";

import {
  SemanticSnapshotEngine,
  StaleReferenceError,
  type BackendSemanticNode,
} from "../src/index.ts";

function node(
  overrides: Partial<BackendSemanticNode> = {},
): BackendSemanticNode {
  return {
    backend_id: "backend-1",
    role: "button",
    accessible_name: "Save",
    ancestry: [
      { role: "main", accessible_name: "Editor" },
      { role: "form", accessible_name: "Project form" },
    ],
    document_id: "document-1",
    frame_id: "frame-top",
    ...overrides,
  };
}

test("snapshot redacts sensitive values and backend-local identifiers", () => {
  const engine = new SemanticSnapshotEngine();
  const snapshot = engine.snapshot(
    [
      node({
        backend_id: "password-node",
        role: "textbox",
        accessible_name: "Password",
        value: "super-secret",
        sensitive: true,
      }),
      node({
        backend_id: "project-node",
        role: "textbox",
        accessible_name: "Project value",
        value: "visible",
      }),
    ],
    { revision: 1 },
  );

  assert.equal(snapshot.nodes.length, 2);
  assert.equal("backend_id" in snapshot.nodes[0]!, false);
  assert.equal(snapshot.nodes[0]?.value, undefined);
  assert.equal(snapshot.nodes[1]?.value, "visible");
  assert.equal(JSON.stringify(snapshot).includes("super-secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("password-node"), false);
});

test("stable semantic reference reacquires a rerendered backend node", () => {
  const engine = new SemanticSnapshotEngine();
  const first = engine.snapshot([node({ backend_id: "old-node" })], {
    revision: 7,
  });
  const second = engine.snapshot([node({ backend_id: "new-node" })], {
    revision: 8,
  });

  const firstRef = first.nodes[0]!.ref;
  const secondRef = second.nodes[0]!.ref;
  assert.equal(firstRef.ref_id, secondRef.ref_id);
  assert.equal(firstRef.snapshot_revision, 7);
  assert.equal(secondRef.snapshot_revision, 8);

  const resolved = engine.reacquire(firstRef, [
    node({ backend_id: "new-node" }),
  ]);
  assert.equal(resolved.backend_id, "new-node");
});

test("semantic reacquisition is frame and document aware", () => {
  const engine = new SemanticSnapshotEngine();
  const ref = engine.snapshot([node()], { revision: 1 }).nodes[0]!.ref;

  assert.throws(
    () =>
      engine.reacquire(ref, [
        node({
          backend_id: "other-frame",
          frame_id: "frame-child",
        }),
      ]),
    (error: unknown) =>
      error instanceof StaleReferenceError &&
      error.code === "stale_reference",
  );

  assert.throws(
    () =>
      engine.reacquire(ref, [
        node({
          backend_id: "other-document",
          document_id: "document-2",
        }),
      ]),
    (error: unknown) =>
      error instanceof StaleReferenceError &&
      error.code === "stale_reference",
  );
});

test("ambiguous semantic reacquisition fails instead of choosing arbitrarily", () => {
  const engine = new SemanticSnapshotEngine();
  const ref = engine.snapshot([node()], { revision: 1 }).nodes[0]!.ref;

  assert.throws(
    () =>
      engine.reacquire(ref, [
        node({ backend_id: "candidate-a" }),
        node({ backend_id: "candidate-b" }),
      ]),
    (error: unknown) =>
      error instanceof StaleReferenceError &&
      error.code === "stale_reference" &&
      error.match_count === 2,
  );
});

test("snapshot is bounded and reports omitted semantic nodes", () => {
  const engine = new SemanticSnapshotEngine();
  const snapshot = engine.snapshot(
    [
      node({ backend_id: "1", accessible_name: "One" }),
      node({ backend_id: "2", accessible_name: "Two" }),
      node({ backend_id: "3", accessible_name: "Three" }),
      node({ backend_id: "4", accessible_name: "Four" }),
    ],
    { revision: 2, max_nodes: 2 },
  );

  assert.equal(snapshot.nodes.length, 2);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.omitted_nodes, 2);
  assert.deepEqual(
    snapshot.nodes.map((item) => item.accessible_name),
    ["One", "Two"],
  );
});

test("duplicate semantic identities get unique snapshot handles but remain ambiguous to reacquire", () => {
  const engine = new SemanticSnapshotEngine();
  const backendNodes = [
    node({ backend_id: "duplicate-a" }),
    node({ backend_id: "duplicate-b" }),
  ];
  const snapshot = engine.snapshot(backendNodes, { revision: 3 });

  assert.equal(snapshot.nodes.length, 2);
  assert.notEqual(
    snapshot.nodes[0]?.ref.ref_id,
    snapshot.nodes[1]?.ref.ref_id,
  );
  assert.throws(
    () => engine.reacquire(snapshot.nodes[0]!.ref, backendNodes),
    (error: unknown) =>
      error instanceof StaleReferenceError &&
      error.match_count === 2,
  );
});
