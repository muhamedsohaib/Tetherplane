import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { describeOwnerPopup, grantPermissionFields } from "../src/popup-status.ts";

const now = 1_800_000_000_000;

test("saved grant after restart is not misrepresented as active remote sharing", () => {
  const view = describeOwnerPopup({
    paired: false, connected: false, shared: true,
    expires_at_ms: now + 29 * 60_000,
    grant_navigate: false, grant_upload: false,
  }, now);
  assert.equal(view.connectionState, "disconnected");
  assert.match(view.connectionText, /Not connected/);
  assert.match(view.statusText, /Local authorization saved/);
  assert.match(view.statusText, /remote access is unavailable/);
  assert.doesNotMatch(view.statusText, /^This tab is shared/);
  assert.equal(view.showConnect, true);
  assert.equal(view.showStopSharing, true);
  assert.equal(view.connectLabel, "Reconnect and share this tab");
  assert.match(view.permissionText, /navigation not allowed/);
});

test("paired but offline state does not imply active access", () => {
  const view = describeOwnerPopup({
    paired: true, connected: false, shared: true,
    expires_at_ms: now + 60_000,
    grant_navigate: true, grant_upload: false,
  }, now);
  assert.equal(view.connectionState, "connecting");
  assert.match(view.connectionText, /connection unavailable/);
  assert.match(view.statusText, /remote access is unavailable/);
});

test("connected full-permission grant reports actual allowed operations", () => {
  const view = describeOwnerPopup({
    paired: true, connected: true, shared: true,
    expires_at_ms: now + 60 * 60_000,
    grant_navigate: true, grant_upload: true,
  }, now);
  assert.equal(view.connectionState, "connected");
  assert.equal(view.showConnect, false);
  assert.equal(view.showStopSharing, true);
  assert.match(view.statusText, /This tab is shared for 60 more minutes/);
  assert.match(view.permissionText, /navigation allowed/);
  assert.match(view.permissionText, /file upload allowed/);
  assert.doesNotMatch(view.permissionText, /off by default/);
});

test("connected observation-only grant accurately reports denied extras", () => {
  const view = describeOwnerPopup({
    paired: true, connected: true, shared: true,
    expires_at_ms: now + 300_000,
    grant_navigate: false, grant_upload: false,
  }, now);
  assert.match(view.permissionText, /navigation not allowed/);
  assert.match(view.permissionText, /upload not allowed/);
});

test("unknown permissions fail closed in presentation", () => {
  const view = describeOwnerPopup({
    paired: true, connected: true, shared: true,
    expires_at_ms: now + 300_000,
  }, now);
  assert.match(view.permissionText, /could not be confirmed/);
  assert.doesNotMatch(view.permissionText, /navigation allowed/);
});

test("unshared tab does not show stop-sharing or pretend to have a grant", () => {
  const view = describeOwnerPopup({
    paired: false, connected: false, shared: false,
  }, now);
  assert.equal(view.showConnect, true);
  assert.equal(view.showStopSharing, false);
  assert.match(view.statusText, /No active remote sharing/);
  assert.match(view.permissionText, /next grant/);
});

test("local grant flags are derived from operations, not checkbox UI choices", () => {
  assert.deepEqual(grantPermissionFields(["snapshot", "act"]), {
    grant_navigate: false, grant_upload: false,
  });
  assert.deepEqual(grantPermissionFields(["snapshot", "navigate", "upload"]), {
    grant_navigate: true, grant_upload: true,
  });
  assert.deepEqual(grantPermissionFields(["snapshot", "upload"]), {
    grant_navigate: false, grant_upload: true,
  });
});

test("popup markup distinguishes live grants and options for future grants", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const html = await readFile(path.resolve(here, "..", "pair.html"), "utf8");
  assert.match(html, /id="connect-summary"/);
  assert.match(html, /id="grant-permissions"/);
  assert.doesNotMatch(html, /Navigation and file uploads are off by default/);
  assert.doesNotMatch(html, /shares only this tab for 5 minutes/);
});
