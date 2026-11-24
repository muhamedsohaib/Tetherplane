import assert from "node:assert/strict";
import test from "node:test";
import { renderControlPortalHtml } from "../src/portal/portal-ui.ts";

test("owner dashboard has desktop and mobile section navigation", () => {
  for (const loginMode of ["token", "oidc"] as const) {
    const html = renderControlPortalHtml(loginMode);
    assert.match(html, /<nav class="owner-nav" aria-label="Dashboard sections">/);
    const targets = [
      ["#devices-container", "Devices"],
      ["#global-controls", "Access"],
      ["#owner-identities", "Operators"],
      ["#security-audit", "Audit"],
    ] as const;
    for (const [target, label] of targets) {
      assert.ok(html.includes('<a href="' + target + '">' + label + '</a>'), "missing " + label + " navigation");
      assert.ok(html.includes('id="' + target.slice(1) + '"'), "missing " + label + " target");
    }
    assert.match(html, /body\[data-auth="signed-out"\] \.owner-nav/);
    assert.match(html, /\.owner-nav a:focus-visible\s*\{/);
    assert.match(html, /@media \(max-width: 600px\)[\s\S]*?\.owner-nav\s*\{\s*position: fixed/);
    assert.match(html, /\.owner-nav a\s*\{\s*padding: 7px 4px;\s*min-height: 44px/);
    assert.match(html, /body\[data-auth="signed-in"\] \.toast-stack\s*\{\s*bottom:/);
  }
});

test("attention filter includes offline devices regardless of last policy ACK", () => {
  const html = renderControlPortalHtml();
  const start = html.indexOf("function deviceNeedsAttention(dev)");
  const end = html.indexOf("function formatSyncDetail(dev)", start);
  assert.ok(start > 0 && end > start, "attention function missing");
  const func = html.slice(start, end);
  assert.match(func, /!dev\.online\s*\|\|/);
  assert.match(func, /dev\.syncStatus === "failed"/);
  assert.match(func, /dev\.emergencyLockdown/);
  assert.match(html, /if \(activeFleetFilter === "attention"\) return deviceNeedsAttention\(dev\)/);
});

test("navigation does not introduce browser token storage or new privileged operations", () => {
  const html = renderControlPortalHtml("oidc");
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
  assert.doesNotMatch(html, /localStorage\.setItem\(/);
  assert.doesNotMatch(html, /sessionStorage\.setItem\(/);
  assert.match(html, /href="\/portal\/auth\/start"/);
  assert.match(html, /id="confirm-modal" role="dialog" aria-modal="true"/);
});
