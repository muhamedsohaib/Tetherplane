import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserOwnershipRegistry,
  BrowserPolicyError,
} from "../src/index.ts";

test("human-owned tab cannot be navigated or closed in background mode", () => {
  const registry = new BrowserOwnershipRegistry();
  registry.register({
    page_id: "page-human",
    ownership: "human",
    active: true,
  });

  for (const operation of ["navigate", "close"] as const) {
    assert.throws(
      () =>
        registry.authorize({
          page_id: "page-human",
          operation,
          mode: "background_only",
        }),
      (error: unknown) =>
        error instanceof BrowserPolicyError &&
        error.code === "permission_denied",
    );
  }
});

test("tetherplane-owned tab may be navigated in background mode", () => {
  const registry = new BrowserOwnershipRegistry();
  registry.register({
    page_id: "page-owned",
    ownership: "tetherplane",
    active: false,
  });

  assert.doesNotThrow(() =>
    registry.authorize({
      page_id: "page-owned",
      operation: "navigate",
      mode: "background_only",
    }),
  );
});

test("shared-observe tab is mutation-denied", () => {
  const registry = new BrowserOwnershipRegistry();
  registry.register({
    page_id: "page-observe",
    ownership: "shared-observe",
    active: false,
  });

  assert.throws(
    () =>
      registry.authorize({
        page_id: "page-observe",
        operation: "act",
        mode: "background_only",
      }),
    (error: unknown) =>
      error instanceof BrowserPolicyError &&
      error.code === "permission_denied",
  );
});

test("shared-authorized tab permits only explicitly granted operations", () => {
  const registry = new BrowserOwnershipRegistry();
  registry.register({
    page_id: "page-shared",
    ownership: "shared-authorized",
    active: false,
    grant: {
      operations: ["snapshot", "act"],
    },
  });

  assert.doesNotThrow(() =>
    registry.authorize({
      page_id: "page-shared",
      operation: "act",
      mode: "background_only",
    }),
  );
  assert.throws(
    () =>
      registry.authorize({
        page_id: "page-shared",
        operation: "navigate",
        mode: "background_only",
      }),
    (error: unknown) =>
      error instanceof BrowserPolicyError &&
      error.code === "permission_denied",
  );
});


test("expired shared-authorized grant is denied", () => {
  const registry = new BrowserOwnershipRegistry();
  registry.register({
    page_id: "page-expired",
    ownership: "shared-authorized",
    active: false,
    grant: {
      operations: ["act"],
      expires_at_ms: Date.now() - 1,
    },
  });

  assert.throws(
    () =>
      registry.authorize({
        page_id: "page-expired",
        operation: "act",
        mode: "background_only",
      }),
    (error: unknown) =>
      error instanceof BrowserPolicyError &&
      error.code === "permission_denied",
  );
});

test("unexpired shared-authorized grant remains usable", () => {
  const registry = new BrowserOwnershipRegistry();
  registry.register({
    page_id: "page-live",
    ownership: "shared-authorized",
    active: false,
    grant: {
      operations: ["act"],
      expires_at_ms: Date.now() + 60_000,
    },
  });

  assert.doesNotThrow(() =>
    registry.authorize({
      page_id: "page-live",
      operation: "act",
      mode: "background_only",
    }),
  );
});


test("human observation stays denied before sharing and immediately after revocation", () => {
  const registry = new BrowserOwnershipRegistry();
  const pageId = "human-revocation-regression";
  const snapshot = () =>
    registry.authorize({
      page_id: pageId,
      operation: "snapshot",
      mode: "background_only",
    });

  registry.register({ page_id: pageId, ownership: "human", active: false });
  assert.throws(snapshot, (error: unknown) =>
    error instanceof BrowserPolicyError && error.code === "permission_denied");

  registry.register({
    page_id: pageId,
    ownership: "shared-observe",
    active: false,
    grant: { operations: ["snapshot"], expires_at_ms: Date.now() + 30_000 },
  });
  assert.doesNotThrow(snapshot);

  registry.register({ page_id: pageId, ownership: "human", active: false });
  assert.throws(snapshot, (error: unknown) =>
    error instanceof BrowserPolicyError && error.code === "permission_denied");
});

test("expired browser sharing grant cannot disclose a semantic snapshot", () => {
  const registry = new BrowserOwnershipRegistry();
  registry.register({
    page_id: "expired-observer",
    ownership: "shared-observe",
    active: false,
    grant: { operations: ["snapshot"], expires_at_ms: Date.now() - 5 },
  });
  assert.throws(
    () => registry.authorize({
      page_id: "expired-observer",
      operation: "snapshot",
      mode: "background_only",
    }),
    (error: unknown) =>
      error instanceof BrowserPolicyError && error.code === "permission_denied",
  );
});
