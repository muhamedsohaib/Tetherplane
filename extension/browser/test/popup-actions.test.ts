import assert from "node:assert/strict";
import test from "node:test";

import {
  detachCurrentTab,
  shareCurrentTab,
  type PopupBrowserApi,
} from "../src/popup-actions.ts";

class FakePopupApi implements PopupBrowserApi {
  readonly sent: unknown[] = [];
  tabs: Array<{ id?: number | undefined }> = [{ id: 42 }];

  async activeTabs() {
    return structuredClone(this.tabs);
  }

  async sendMessage(message: unknown) {
    this.sent.push(structuredClone(message));
    return { handled: true };
  }
}

test("share current tab sends only the active tab and selected scope", async () => {
  const api = new FakePopupApi();

  await shareCurrentTab(api, {
    ttl_ms: 600_000,
    allow_navigate: true,
    allow_upload: false,
  });

  assert.deepEqual(api.sent, [
    {
      type: "tetherplane.share_current_tab",
      tab_id: 42,
      ttl_ms: 600_000,
      allow_navigate: true,
      allow_upload: false,
    },
  ]);
});

test("detach current tab sends only the active tab", async () => {
  const api = new FakePopupApi();

  await detachCurrentTab(api);

  assert.deepEqual(api.sent, [
    {
      type: "tetherplane.detach_current_tab",
      tab_id: 42,
    },
  ]);
});

test("popup refuses to share when there is no active stable tab", async () => {
  const api = new FakePopupApi();
  api.tabs = [{}];

  await assert.rejects(
    () =>
      shareCurrentTab(api, {
        ttl_ms: 600_000,
        allow_navigate: true,
        allow_upload: false,
      }),
    /active browser tab is unavailable/,
  );

  assert.equal(api.sent.length, 0);
});
