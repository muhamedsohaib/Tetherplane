import assert from "node:assert/strict";
import test from "node:test";
import { renderControlPortalHtml } from "../src/portal/portal-ui.ts";

test("owner portal has accessible iPhone-safe feedback toasts", () => {
  const html = renderControlPortalHtml();
  assert.match(html, /id="toast-stack"[^>]*aria-live="polite"/);
  assert.match(html, /safe-area-inset-bottom/);
  assert.match(html, /role: level === "error" \? "alert" : "status"/);
  assert.match(html, /toastStack\.childElementCount >= 3/);
  assert.match(html, /\.textContent = String\(options\.text\)/);
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
});
test("portal never reports access granted merely from relay HTTP acceptance", () => {
  const html = renderControlPortalHtml();
  assert.match(html, /Waiting for device confirmation/);
  assert.match(html, /dev\.online && d\.confirmedByDevice === true|d\.online && d\.confirmedByDevice === true/);
  assert.match(html, /Number\(d\.appliedRevision\) === change\.revision/);
  assert.match(html, /policy-rejected/);
  assert.match(html, /policy-confirmed/);
  assert.match(html, /desiredRevision: response\.device\.desiredRevision/);
});
test("directory-only operator removal does not claim a device acknowledgment", () => {
  const html = renderControlPortalHtml();
  assert.match(html, /typeof response\.removed === "string"/);
  assert.match(html, /No active device grants to revoke/);
  assert.match(html, /"info", "operator-directory-removed"/);
  assert.match(html, /"info", "policy-no-change"/);
});

test("private owner portal shows devices before fleet-wide actions on mobile", () => {
  const html = renderControlPortalHtml();
  const deviceIndex = html.indexOf('id="devices-container"');
  const globalIndex = html.indexOf('class="global-panel"');
  const mobileCssIndex = html.indexOf("@media (max-width: 600px)");
  assert.ok(deviceIndex > 0 && globalIndex > deviceIndex, "device controls come before fleet-wide actions");
  assert.ok(mobileCssIndex > 0, "mobile breakpoint exists");
  assert.ok(
    html.indexOf("grid-template-columns: repeat(2, minmax(0, 1fr))", mobileCssIndex) > mobileCssIndex,
    "mobile summary uses compact two-column grid",
  );
});

test("passive alerts require opt-in; no misleading iOS push claims", () => {
  const html = renderControlPortalHtml();
  assert.match(html, /id="live-alerts-btn"[^>]*aria-pressed="false"/);
  assert.match(html, /let livePageAlerts = false/);
  assert.match(html, /!livePageAlerts \|\| !prior/);
  assert.match(html, /iPhone background push is not yet configured/);
  assert.doesNotMatch(html, /Notification\.requestPermission\(|new Notification\(/);
  assert.doesNotMatch(html, /localStorage\.setItem|sessionStorage\.setItem/);
});

test("signed-in header hides token input and connect button while tracking live stream state", () => {
  const html = renderControlPortalHtml();
  assert.match(html, /tokenInput\.classList\.add\("hidden"\)/);
  assert.match(html, /connectBtn\.classList\.add\("hidden"\)/);
  assert.match(html, /document\.body\.dataset\.auth\s*=\s*"signed-in"/);
  assert.match(html, /document\.body\.dataset\.auth\s*=\s*"signed-out"/);
  assert.match(html, /id="live-stream-badge"/);
});

test("device cards clearly separate relay acceptance, offline queueing, device confirmation, and rejection", () => {
  const html = renderControlPortalHtml();
  assert.match(html, /syncDetail:\s*dev\.deviceId/);
  assert.match(html, /Relay accepted v/);
  assert.match(html, /Relay queued v/);
  assert.match(html, /Device confirmed v/);
  assert.match(html, /Device rejected v/);
});

test("portal exposes partial family status, one-tap denied-op allow chips, canonical autocomplete, and fleet filters", () => {
  const html = renderControlPortalHtml();
  assert.match(html, /PARTIAL/);
  assert.match(html, /allow-denied-op/);
  assert.match(html, /id="canonical-ops-list"/);
  assert.match(html, /id="fleet-filter-bar"/);
  assert.match(html, /Confirmed by device/);
  assert.match(html, /Queued \(offline\)/);
  assert.match(html, /Pending device ACK/);
});

test("modal supports Escape/backdrop dismissal and mobile enforces 44px touch targets without img or svg tags", () => {
  const html = renderControlPortalHtml();
  assert.match(html, /e\.key === "Escape"/);
  const mobileCssIndex = html.indexOf("@media (max-width: 600px)");
  assert.ok(mobileCssIndex > 0);
  assert.ok(
    html.indexOf("min-height: 44px", mobileCssIndex) > mobileCssIndex,
    "mobile controls should enforce 44px touch targets",
  );
  assert.doesNotMatch(html, /<img\b|<svg\b/i);
});
