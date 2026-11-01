import assert from "node:assert/strict";
import test from "node:test";

import { BrowserPolicyError } from "@tetherplane/browser-bridge";

import {
  handleLocalApprovalMessage as handleLocalApprovalMessageWithContext,
  type LocalApprovalController,
} from "../src/approval.ts";

const OWNER_POPUP_URL = "chrome-extension://fixture/pair.html";

// Existing positive cases use the exact local popup sender.
function handleLocalApprovalMessage(
  controller: LocalApprovalController,
  message: unknown,
) {
  return handleLocalApprovalMessageWithContext(controller, message, {
    senderUrl: OWNER_POPUP_URL,
    ownerPopupUrl: OWNER_POPUP_URL,
  });
}

class FakeController implements LocalApprovalController {
  attachCalls: Array<{
    tabId: number;
    grant: { operations: string[]; ttl_ms: number };
  }> = [];
  detachCalls: number[] = [];
  siteGrants: Array<{tabId: number; ttl_ms: number; operations: string[]}> = [];
  siteRevokes: number[] = [];

  async approveOwnedOriginFromTab(tabId: number, grant: {
    ttl_ms: number; operations: string[];
  }) {
    this.siteGrants.push({tabId, ...structuredClone(grant)});
    return {origin: "https://synthetic.example"};
  }

  async revokeOwnedOriginFromTab(tabId: number) {
    this.siteRevokes.push(tabId);
    return null;
  }

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


test("site-origin permission is a separate explicit owner approval", async () => {
  const controller = new FakeController();
  const response = await handleLocalApprovalMessage(controller, {
    type: "tetherplane.approve_owned_site",
    tab_id: 7, ttl_ms: 300_000, allow_navigate: true, allow_upload: false,
  });
  assert.equal(response.handled, true);
  assert.deepEqual(controller.siteGrants, [
    { tabId: 7, ttl_ms: 300_000, operations: ["act", "navigate"] },
  ]);
  assert.equal(controller.attachCalls.length, 0, "site approval must not silently share a human tab");
});

test("site-origin grant can be revoked separately from human-tab sharing", async () => {
  const controller = new FakeController();
  await handleLocalApprovalMessage(controller, {
    type: "tetherplane.revoke_owned_site", tab_id: 5,
  });
  assert.deepEqual(controller.siteRevokes, [5]);
  assert.equal(controller.detachCalls.length, 0);
});

test("site-origin grants reject invalid TTL before reaching the controller", async () => {
  const controller = new FakeController();
  await assert.rejects(
    () => handleLocalApprovalMessage(controller, {
      type: "tetherplane.approve_owned_site",
      tab_id: 7, ttl_ms: 3_600_001, allow_navigate: true,
    }),
    (e: unknown) => e instanceof BrowserPolicyError && e.code === "invalid_arguments",
  );
  assert.equal(controller.siteGrants.length, 0);
});


test("non-owner extension context cannot approve or revoke tab access", async () => {
  const controller = new FakeController();
  // Exercise the proposed sender-bound API before implementation.
  const senderBoundHandler = handleLocalApprovalMessageWithContext as unknown as (
    ctrl: LocalApprovalController,
    message: unknown,
    context: { senderUrl: string; ownerPopupUrl: string },
  ) => ReturnType<typeof handleLocalApprovalMessageWithContext>;
  const context = {
    senderUrl: "chrome-extension://fixture/untrusted.html",
    ownerPopupUrl: "chrome-extension://fixture/pair.html",
  };
  for (const message of [
    {type:"tetherplane.share_current_tab",tab_id:17,
      ttl_ms:300_000,allow_navigate:true},
    {type:"tetherplane.detach_current_tab",tab_id:17},
    {type:"tetherplane.approve_owned_site",tab_id:17,ttl_ms:300_000},
    {type:"tetherplane.revoke_owned_site",tab_id:17},
  ]) {
    await assert.rejects(
      () => senderBoundHandler(controller,message,context),
      (e: unknown) => e instanceof BrowserPolicyError && e.code === "permission_denied",
    );
  }
  assert.equal(controller.attachCalls.length,0);
  assert.equal(controller.detachCalls.length,0);
  assert.equal(controller.siteGrants.length,0);
  assert.equal(controller.siteRevokes.length,0);
});
