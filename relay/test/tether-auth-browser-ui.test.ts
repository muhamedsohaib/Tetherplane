import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import { TetherAuthServer } from "../../auth/src/server.ts";

const uid = "interaction_123";
const safeCode = "ABCD-1234";

function extractCsrf(html: string): string {
  const match = /name="csrf" value="([a-f0-9]{64})"/.exec(html);
  assert.ok(match, "browser form must carry an unpredictable interaction-specific CSRF token");
  return match[1]!;
}

test("human login uses an escaped no-store HTML form and resumes the provider redirect after device approval", async () => {
  let approved = false;
  const calls: string[] = [];
  const server = new TetherAuthServer({
    providerHandler(_request, response) { response.writeHead(404).end(); },
    interactions: {
      async beginLogin() { throw new Error("legacy API should not be used"); },
      async beginInteraction(_request: IncomingMessage, _response: ServerResponse, interactionUid: string) {
        calls.push("begin:" + interactionUid);
        return { kind: "login" as const, userCode: safeCode, expiresAt: "2030-10-14T16:00:00.000Z" };
      },
      async completeLogin(_request: IncomingMessage, response: ServerResponse, input: { interactionUid: string; userCode: string }) {
        calls.push("complete:" + input.interactionUid + ":" + input.userCode);
        if (!approved) return "pending" as const;
        response.writeHead(302, { location: "https://client.example/callback" }).end();
        return "completed" as const;
      },
    },
    allowInsecureLocalhost: true,
  });

  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const page = await fetch(address.url + "/interaction/" + uid, { headers: { accept: "text/html,application/xhtml+xml" } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(page.headers.get("content-security-policy") ?? "", /form-action 'self'/);
    const html = await page.text();
    assert.match(html, /Tetherplane/);
    assert.ok(html.includes(safeCode), "login page must show the one-time code to approve on the paired device");
    assert.ok(html.includes('action="/interaction/' + uid + '/device-login"'));
    const csrf = extractCsrf(html);
    assert.deepEqual(calls, ["begin:" + uid], "GET must not approve anything");

    const rejected = await fetch(address.url + "/interaction/" + uid + "/device-login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ userCode: safeCode }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(calls, ["begin:" + uid], "missing CSRF must not reach the approval handler");

    const form = new URLSearchParams({ userCode: safeCode, csrf });
    const pending = await fetch(address.url + "/interaction/" + uid + "/device-login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: form,
    });
    assert.equal(pending.status, 202);
    assert.match(pending.headers.get("content-type") ?? "", /^text\/html/);
    assert.match(await pending.text(), /waiting|pending|approve/i);

    approved = true;
    const finished = await fetch(address.url + "/interaction/" + uid + "/device-login", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: form,
    });
    assert.equal(finished.status, 302);
    assert.equal(finished.headers.get("location"), "https://client.example/callback");
    assert.deepEqual(calls, ["begin:" + uid, "complete:" + uid + ":" + safeCode, "complete:" + uid + ":" + safeCode]);
  } finally {
    await server.close();
  }
});

test("consent browser form renders scope and client safely and never mutates grants on GET", async () => {
  const calls: string[] = [];
  const clientId = '<img src="x" onerror="alert(1)">';
  const resource = "https://mcp.example.com/mcp";
  const server = new TetherAuthServer({
    providerHandler(_request, response) { response.writeHead(404).end(); },
    interactions: {
      async beginLogin() { throw new Error("must not run"); },
      async completeLogin() { throw new Error("must not run"); },
      async beginInteraction(_request: IncomingMessage, _response: ServerResponse, interactionUid: string) {
        calls.push("begin:" + interactionUid);
        return { kind: "consent" as const, clientId, oidcScopes: ["openid"], resourceScopes: [{ resource, scopes: ["tetherplane:access"] }] };
      },
      async completeConsent(_request: IncomingMessage, response: ServerResponse, interactionUid: string) {
        calls.push("grant:" + interactionUid);
        response.writeHead(302, { location: "https://client.example/authorized" }).end();
        return "completed" as const;
      },
    },
    allowInsecureLocalhost: true,
  });

  try {
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const page = await fetch(address.url + "/interaction/" + uid, { headers: { accept: "text/html" } });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    const html = await page.text();
    assert.ok(html.includes("&lt;img"), "untrusted client ID must be escaped");
    assert.ok(!html.includes(clientId), "raw HTML supplied as client ID must never appear in the page");
    assert.ok(html.includes(resource));
    assert.ok(html.includes("tetherplane:access"));
    assert.ok(html.includes('action="/interaction/' + uid + '/consent"'));
    const csrf = extractCsrf(html);
    assert.deepEqual(calls, ["begin:" + uid]);

    const invalid = await fetch(address.url + "/interaction/" + uid + "/consent", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ csrf: "0".repeat(64) }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(calls, ["begin:" + uid], "a forged consent must never create a grant");

    const accepted = await fetch(address.url + "/interaction/" + uid + "/consent", {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ csrf }),
    });
    assert.equal(accepted.status, 302);
    assert.equal(accepted.headers.get("location"), "https://client.example/authorized");
    assert.deepEqual(calls, ["begin:" + uid, "grant:" + uid]);
  } finally {
    await server.close();
  }
});
