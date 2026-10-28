import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { startBrowserLab } from "@tetherplane/browser-lab";
import {
  CdpBrowserBackend,
  launchCdpOwnedBrowser,
} from "../src/index.ts";

// A credentialed profile is deliberately NOT used in this acceptance test.
test("private CDP pipe drives owned Browser Lab tab without a TCP debugger", {
  timeout: 70_000,
  skip: process.platform !== "win32",
}, async () => {
  const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  assert.ok(existsSync(chrome), "Windows Chrome is required for this test");
  const lab = await startBrowserLab();
  let profileDir: string | null = null;
  try {
    const control = await launchCdpOwnedBrowser({
      executablePath: chrome,
      privatePipe: true,
      launchTimeoutMs: 20_000,
    });
    profileDir = control.profile_dir;
    const backend = new CdpBrowserBackend({ control, pollIntervalMs: 20 });
    try {
      assert.equal(
        existsSync(path.join(profileDir, "DevToolsActivePort")),
        false,
        "private CDP must not start a raw TCP debugging endpoint",
      );
      const page = await backend.createTab(lab.origin);
      assert.equal(page.ownership, "tetherplane");
      assert.equal(page.active, false);
      const observed = await backend.observe(page.page_id);
      assert.ok(observed.nodes.some((node) => node.accessible_name === "Save"));
      await backend.close(page.page_id);
      assert.deepEqual(await backend.pages(), []);
    } finally {
      await backend.shutdown();
    }
    assert.equal(existsSync(profileDir), false);
  } finally {
    await lab.close();
  }
});
