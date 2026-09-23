import assert from "node:assert/strict";
import test from "node:test";

import { BrowserPolicyError } from "@tetherplane/browser-bridge";

import {
  handleLocalApprovalMessage,
  type LocalApprovalController,
} from "../src/approval.ts";

class FakeController implements LocalApprovalController {
  attachCalls: Array<{
    tabId: number;
    grant: { operations: string[]; ttl_ms: number };
  }> = [];
  detachCalls: number[] = [];

  async attachHumanTab(
    tabId: number,
    grant: { operations: string[]; ttl_ms: number },
  ) {
    this.attachCalls.push({
      tabId,
      grant: structuredClone(grant),
    });
    return {
      page_id: `tab:${tabId}`,
      ownership: "shared-authorized",
      grant,
    };
  }

  async detachHumanTab(tabId: number) {
    this.detachCalls.push(tabId);
    return {
      page_id: `tab:${tabId}`,
      ownership: "human",
    };
  }
}

test("local share approval constructs a bounded per-tab grant", async () => {
  const controller = new FakeController();

  const result = await handleLocalApprovalMessage(controller, {
    type: "tetherplane.share_current_tab",
    tab_id: 7,
    ttl_ms: 600_000,
    allow_navigate: true,
    allow_upload: true,
  });

  assert.equal(result.handled, true);
  assert.deepEqual(controller.attachCalls, [
    {
      tabId: 7,
      grant: {
        operations: ["act", "navigate", "upload"],
        ttl_ms: 600_000,
      },
    },
  ]);
});

test("local detach approval revokes only the requested tab", async () => {
  const controller = new FakeController();

  const result = await handleLocalApprovalMessage(controller, {
    type: "tetherplane.detach_current_tab",
    tab_id: 9,
  });

  assert.equal(result.handled, true);
  assert.deepEqual(controller.detachCalls, [9]);
  assert.equal(controller.attachCalls.length, 0);
});

test("local share approval rejects excessive TTL", async () => {
  const controller = new FakeController();

  await assert.rejects(
    () =>
      handleLocalApprovalMessage(controller, {
        type: "tetherplane.share_current_tab",
        tab_id: 7,
        ttl_ms: 3_600_001,
        allow_navigate: true,
        allow_upload: false,
      }),
    (error: unknown) =>
      error instanceof BrowserPolicyError &&
      error.code === "invalid_arguments",
  );
});

test("unrelated extension messages are ignored", async () => {
  const controller = new FakeController();

  const result = await handleLocalApprovalMessage(controller, {
    type: "unrelated.message",
  });

  assert.deepEqual(result, { handled: false });
  assert.equal(controller.attachCalls.length, 0);
  assert.equal(controller.detachCalls.length, 0);
});
