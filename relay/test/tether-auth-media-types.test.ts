import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { exportJWK, generateKeyPair } from "jose";

import { createSqliteAdapter } from "../../auth/src/sqlite-adapter.ts";
import { createTetherAuthRuntime } from "../../auth/src/runtime.ts";

const FORM = "Application/X-WWW-Form-Urlencoded; charset=UTF-8";
const JSON_TYPE = "Application/JSON; charset=utf-8";
const USER_CODE = "ABCD-1234";
const HOSTILE_ORIGIN = "https://hostile.example.test";

type Interaction = { url: URL; csrf: string };

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tether-media-types-"));
  const databasePath = join(directory, "provider.sqlite");
  const storage = createSqliteAdapter({ databasePath });
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateJwk = {
    ...(await exportJWK(keys.privateKey)),
    kid: "media-types",
    alg: "RS256",
    use: "sig",
  };
  let proofAvailable = true;
  const runtime = createTetherAuthRuntime({
    issuer: "https://auth.example.test/",
    resource: "https://mcp.example.test/mcp",
    interactionBasePath: "/interaction",
    jwks: { keys: [privateJwk] },
    adapter: storage.Adapter,
    logins: {
      start: async () => ({
        userCode: USER_CODE,
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      consume: async () => {
        if (!proofAvailable) return null;
        proofAvailable = false;
        return { accountId: "account-a" };
      },
    },
    allowInsecureLocalhost: true,
  });
  const address = await runtime.server.listen({ host: "127.0.0.1", port: 0 });
  const jar = new Map<string, string>();
  function remember(response: Response) {
    for (const entry of response.headers.getSetCookie()) {
      const pair = entry.split(";")[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator > 0) jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  async function request(url: string | URL, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (jar.size) {
      headers.set("cookie", [...jar].map(([name, value]) => name + "=" + value).join("; "));
    }
    const response = await fetch(url, { ...options, headers, redirect: "manual" });
    remember(response);
    return response;
  }
  async function describe(url: URL): Promise<Interaction> {
    const page = await request(url, { headers: { accept: "text/html" } });
    assert.equal(page.status, 200);
    const html = await page.text();
    const csrf = /name="csrf" value="([a-f0-9]{64})"/.exec(html)?.[1];
    assert.ok(csrf, "the real provider interaction must render its form proof");
    return { url, csrf };
  }
  async function begin(): Promise<Interaction> {
    const registered = await request(address.url + "/reg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:8765/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "openid offline_access tetherplane:access",
      }),
    });
    assert.equal(registered.status, 201);
    const client = await registered.json() as { client_id: string };
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:8765/callback",
      response_type: "code",
      scope: "openid offline_access tetherplane:access",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource: "https://mcp.example.test/mcp",
      state: "media-type-state",
    });
    const started = await request(address.url + "/auth?" + params.toString());
    assert.equal(started.status, 303);
    const location = started.headers.get("location");
    assert.ok(location);
    await started.text();
    return describe(new URL(location, address.url));
  }
  async function submit(
    interaction: Interaction,
    endpoint: "device-login" | "consent",
    contentType: string,
    csrf: string | undefined = interaction.csrf,
  ) {
    const body = contentType.toLowerCase().startsWith("application/json")
      ? endpoint === "device-login" ? JSON.stringify({ userCode: USER_CODE }) : undefined
      : new URLSearchParams({
          ...(endpoint === "device-login" ? { userCode: USER_CODE } : {}),
          ...(csrf === undefined ? {} : { csrf }),
        });
    return request(interaction.url.href + "/" + endpoint, {
      method: "POST",
      headers: { "content-type": contentType },
      ...(body === undefined ? {} : { body }),
    });
  }
  async function resume(response: Response) {
    assert.equal(response.status, 303);
    const location = response.headers.get("location");
    assert.ok(location);
    await response.text();
    const resumed = await request(new URL(location, address.url));
    assert.equal(resumed.status, 303);
    const next = resumed.headers.get("location");
    assert.ok(next);
    await resumed.text();
    return new URL(next, address.url);
  }
  function grantCount() {
    return Number(database.prepare(
      "SELECT COUNT(*) AS count FROM oidc_objects WHERE model = 'Grant'",
    ).get()!.count);
  }
  return {
    begin, describe, request, submit, resume, grantCount,
    async close() {
      await runtime.server.close();
      database.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const endpoint of ["device-login", "consent"] as const) {
  for (const contentType of ["text/plain", "multipart/form-data; boundary=fixture", undefined]) {
    test(endpoint + " rejects " + (contentType ?? "missing content type") + " before changing the real interaction", async () => {
      const flow = await fixture();
      try {
        let interaction = await flow.begin();
        if (endpoint === "consent") {
          interaction = await flow.describe(await flow.resume(
            await flow.submit(interaction, "device-login", JSON_TYPE),
          ));
        }
        const rejected = await flow.request(interaction.url.href + "/" + endpoint, {
          method: "POST",
          headers: {
            origin: HOSTILE_ORIGIN,
            ...(contentType ? { "content-type": contentType } : {}),
          },
          // Bytes avoid fetch adding text/plain for the missing-header case.
          body: Buffer.from(JSON.stringify({ userCode: USER_CODE })),
        });
        await rejected.text();
        assert.equal(rejected.status, 415, "unsupported browser request must not complete an interaction");
        assert.equal(flow.grantCount(), 0, "rejected consent must not save a grant");

        for (const fields of [{}, { csrf: "0".repeat(64) }]) {
          const invalid = await flow.request(interaction.url.href + "/" + endpoint, {
            method: "POST",
            headers: { "content-type": FORM, origin: HOSTILE_ORIGIN },
            body: new URLSearchParams({
              ...(endpoint === "device-login" ? { userCode: USER_CODE } : {}),
              ...fields,
            }),
          });
          await invalid.text();
          assert.equal(invalid.status, 400, "URL-encoded forms still require the correct proof");
          assert.equal(flow.grantCount(), 0);
        }

        // A correct form still completes: rejected login requests must leave
        // the approved one-time device proof available for this submission.
        let next = await flow.resume(await flow.submit(interaction, endpoint, FORM));
        if (endpoint === "device-login") {
          const consent = await flow.describe(next);
          next = await flow.resume(await flow.submit(consent, "consent", FORM));
        }
        assert.equal(next.origin, "http://127.0.0.1:8765");
        assert.equal(next.searchParams.get("state"), "media-type-state");
        assert.ok(next.searchParams.has("code"));
        assert.equal(flow.grantCount(), 1);
      } finally {
        await flow.close();
      }
    });
  }
}

for (const contentType of ["application/json", JSON_TYPE]) {
  test("explicit " + contentType + " preserves the machine login and bodyless consent contract", async () => {
    const flow = await fixture();
    try {
      const login = await flow.begin();
      const consent = await flow.describe(await flow.resume(
        await flow.submit(login, "device-login", contentType),
      ));
      const callback = await flow.resume(await flow.submit(consent, "consent", contentType));
      assert.equal(callback.origin, "http://127.0.0.1:8765");
      assert.ok(callback.searchParams.has("code"));
      assert.equal(flow.grantCount(), 1);
    } finally {
      await flow.close();
    }
  });
}
