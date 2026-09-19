import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserOwnershipRegistry,
  SemanticSnapshotEngine,
  VerifiedActionEngine,
  type BackendSemanticNode,
  type BrowserBridgeBackend,
  type BrowserObservedState,
  type ResolvedBrowserAction,
} from "../src/index.ts";

function semanticNode(
  overrides: Partial<BackendSemanticNode> = {},
): BackendSemanticNode {
  return {
    backend_id: "input-old",
    role: "textbox",
    accessible_name: "Project value",
    ancestry: [{ role: "main", accessible_name: "Editor" }],
    document_id: "document-1",
    frame_id: "frame-top",
    value: "initial",
    ...overrides,
  };
}

function state(
  overrides: Partial<BrowserObservedState> = {},
): BrowserObservedState {
  return {
    page_id: "page-owned",
    url: "https://fixture.local/editor",
    semantic_revision: 1,
    resource_revision: "resource-1",
    nodes: [semanticNode()],
    validation_messages: [],
    toasts: [],
    ...overrides,
  };
}

class FakeBackend implements BrowserBridgeBackend {
  current: BrowserObservedState;
  readonly nextStates: BrowserObservedState[];
  readonly performed: ResolvedBrowserAction[] = [];
  waitCalls = 0;

  constructor(
    current: BrowserObservedState,
    nextStates: BrowserObservedState[] = [],
  ) {
    this.current = structuredClone(current);
    this.nextStates = nextStates.map((item) => structuredClone(item));
  }

  async observe(_pageId: string): Promise<BrowserObservedState> {
    return structuredClone(this.current);
  }

  async perform(
    _pageId: string,
    action: ResolvedBrowserAction,
  ): Promise<void> {
    this.performed.push(structuredClone(action));
  }

  async waitForSettled(
    _pageId: string,
    _afterRevision: number,
    _timeoutMs: number,
  ): Promise<BrowserObservedState> {
    this.waitCalls += 1;
    const next = this.nextStates.shift();
    if (next) {
      this.current = structuredClone(next);
    }
    return structuredClone(this.current);
  }
}

function backendId(
  action: ResolvedBrowserAction | undefined,
): string | undefined {
  if (!action || action.kind === "navigate") {
    return undefined;
  }
  return action.backend_id;
}

function ownership(): BrowserOwnershipRegistry {
  const registry = new BrowserOwnershipRegistry();
  registry.register({
    page_id: "page-owned",
    ownership: "tetherplane",
    active: false,
  });
  return registry;
}

test("verified action waits for persisted semantic state before succeeding", async () => {
  const semantics = new SemanticSnapshotEngine();
  const before = state();
  const ref = semantics.snapshot(before.nodes, { revision: 1 }).nodes[0]!.ref;
  const after = state({
    semantic_revision: 2,
    resource_revision: "resource-2",
    nodes: [semanticNode({ backend_id: "input-new", value: "saved" })],
    toasts: ["Saved"],
  });
  const backend = new FakeBackend(before, [after]);
  const engine = new VerifiedActionEngine({
    backend,
    ownership: ownership(),
    semantics,
  });

  const result = await engine.execute({
    page_id: "page-owned",
    mode: "background_only",
    actions: [{ kind: "fill", target: ref, value: "saved" }],
    expectations: [{ kind: "value", target: ref, equals: "saved" }],
    timeout_ms: 1_000,
  });

  assert.equal(result.state, "verified");
  assert.equal(backend.waitCalls, 1);
  assert.equal(backend.performed.length, 1);
  assert.equal(backendId(backend.performed[0]), "input-old");
  assert.equal(result.after_semantic_revision, 2);
});

test("validation failure is machine-readable instead of reported as verified", async () => {
  const semantics = new SemanticSnapshotEngine();
  const before = state();
  const ref = semantics.snapshot(before.nodes, { revision: 1 }).nodes[0]!.ref;
  const after = state({
    semantic_revision: 2,
    nodes: [semanticNode({ value: "" })],
    validation_messages: ["Value is required"],
  });
  const backend = new FakeBackend(before, [after]);
  const engine = new VerifiedActionEngine({
    backend,
    ownership: ownership(),
    semantics,
  });

  const result = await engine.execute({
    page_id: "page-owned",
    mode: "background_only",
    actions: [{ kind: "fill", target: ref, value: "" }],
    expectations: [{ kind: "validation_absent" }],
  });

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "validation_failed");
  assert.deepEqual(result.validation_messages, ["Value is required"]);
});

test("multi-action request reacquires stale targets after SPA rerender", async () => {
  const semantics = new SemanticSnapshotEngine();
  const initialNodes = [
    semanticNode({
      backend_id: "save-old",
      role: "button",
      accessible_name: "Save",
      value: undefined,
    }),
    semanticNode({ backend_id: "input-old" }),
  ];
  const before = state({ nodes: initialNodes });
  const snapshot = semantics.snapshot(initialNodes, { revision: 1 });
  const saveRef = snapshot.nodes[0]!.ref;
  const inputRef = snapshot.nodes[1]!.ref;

  const afterClick = state({
    semantic_revision: 2,
    nodes: [
      semanticNode({
        backend_id: "save-new",
        role: "button",
        accessible_name: "Save",
        value: undefined,
      }),
      semanticNode({ backend_id: "input-new" }),
    ],
  });
  const afterFill = state({
    semantic_revision: 3,
    resource_revision: "resource-2",
    nodes: [
      semanticNode({
        backend_id: "save-newer",
        role: "button",
        accessible_name: "Save",
        value: undefined,
      }),
      semanticNode({ backend_id: "input-newer", value: "updated" }),
    ],
  });

  const backend = new FakeBackend(before, [afterClick, afterFill]);
  const engine = new VerifiedActionEngine({
    backend,
    ownership: ownership(),
    semantics,
  });

  const result = await engine.execute({
    page_id: "page-owned",
    mode: "background_only",
    actions: [
      { kind: "click", target: saveRef },
      { kind: "fill", target: inputRef, value: "updated" },
    ],
    expectations: [{ kind: "value", target: inputRef, equals: "updated" }],
  });

  assert.equal(result.state, "verified");
  assert.equal(backendId(backend.performed[0]), "save-old");
  assert.equal(backendId(backend.performed[1]), "input-new");
});

test("checkpoint revision conflict blocks action before provider mutation", async () => {
  const semantics = new SemanticSnapshotEngine();
  const before = state({ resource_revision: "resource-2" });
  const ref = semantics.snapshot(before.nodes, { revision: 1 }).nodes[0]!.ref;
  const backend = new FakeBackend(before);
  const engine = new VerifiedActionEngine({
    backend,
    ownership: ownership(),
    semantics,
  });

  const result = await engine.execute({
    page_id: "page-owned",
    mode: "background_only",
    expected_resource_revision: "resource-1",
    actions: [{ kind: "fill", target: ref, value: "blocked" }],
  });

  assert.equal(result.state, "conflict");
  assert.equal(result.error?.code, "resource_conflict");
  assert.equal(backend.performed.length, 0);
});

test("ambiguous stale reference fails without arbitrary action", async () => {
  const semantics = new SemanticSnapshotEngine();
  const ref = semantics.snapshot([semanticNode()], { revision: 1 }).nodes[0]!.ref;
  const before = state({
    semantic_revision: 2,
    nodes: [
      semanticNode({ backend_id: "candidate-a" }),
      semanticNode({ backend_id: "candidate-b" }),
    ],
  });
  const backend = new FakeBackend(before);
  const engine = new VerifiedActionEngine({
    backend,
    ownership: ownership(),
    semantics,
  });

  const result = await engine.execute({
    page_id: "page-owned",
    mode: "background_only",
    actions: [{ kind: "fill", target: ref, value: "unsafe" }],
  });

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "stale_reference");
  assert.equal(backend.performed.length, 0);
});

test("failed precondition blocks action before provider mutation", async () => {
  const semantics = new SemanticSnapshotEngine();
  const before = state({ url: "https://fixture.local/other" });
  const ref = semantics.snapshot(before.nodes, { revision: 1 }).nodes[0]!.ref;
  const backend = new FakeBackend(before);
  const engine = new VerifiedActionEngine({
    backend,
    ownership: ownership(),
    semantics,
  });

  const result = await engine.execute({
    page_id: "page-owned",
    mode: "background_only",
    preconditions: [
      { kind: "url", equals: "https://fixture.local/editor" },
    ],
    actions: [{ kind: "fill", target: ref, value: "blocked" }],
  });

  assert.equal(result.state, "precondition_failed");
  assert.equal(result.error?.code, "precondition_failed");
  assert.equal(backend.performed.length, 0);
});

test("semantic wait resolves on resulting application state without dispatching an action", async () => {
  const semantics = new SemanticSnapshotEngine();
  const before = state();
  const after = state({
    semantic_revision: 2,
    toasts: ["Saved successfully"],
  });
  const backend = new FakeBackend(before, [after]);
  const engine = new VerifiedActionEngine({
    backend,
    ownership: ownership(),
    semantics,
  });

  const result = await engine.wait({
    page_id: "page-owned",
    expectations: [{ kind: "toast", includes: "Saved" }],
    timeout_ms: 1_000,
  });

  assert.equal(result.state, "verified");
  assert.equal(backend.waitCalls, 1);
  assert.equal(backend.performed.length, 0);
});

test("semantic wait fails cleanly when no relevant state transition occurs", async () => {
  const backend = new FakeBackend(state());
  const engine = new VerifiedActionEngine({
    backend,
    ownership: ownership(),
  });

  const result = await engine.wait({
    page_id: "page-owned",
    expectations: [{ kind: "toast", includes: "Never appears" }],
    timeout_ms: 50,
  });

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "semantic_wait_timeout");
  assert.equal(backend.performed.length, 0);
});

test("transactional action engine enforces human-tab ownership before backend mutation", async () => {
  const semantics = new SemanticSnapshotEngine();
  const humanState = state({ page_id: "page-human" });
  const ref = semantics.snapshot(humanState.nodes, {
    revision: 1,
  }).nodes[0]!.ref;
  const registry = new BrowserOwnershipRegistry();
  registry.register({
    page_id: "page-human",
    ownership: "human",
    active: true,
  });
  const backend = new FakeBackend(humanState);
  const engine = new VerifiedActionEngine({
    backend,
    ownership: registry,
    semantics,
  });

  const result = await engine.execute({
    page_id: "page-human",
    mode: "background_only",
    actions: [{ kind: "fill", target: ref, value: "blocked" }],
  });

  assert.equal(result.state, "failed");
  assert.equal(result.error?.code, "permission_denied");
  assert.equal(backend.performed.length, 0);
});
