import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as config from "../src/cli-config.ts";

test("CLI selects OIDC explicitly, advertises its audience, and rejects mixed or malformed auth configuration", async () => {
  assert.equal(typeof config.loadClientAuth, "function");
  const dir = await mkdtemp(path.join(os.tmpdir(), "oauth-config-"));
  const file = path.join(dir, "auth.json");
  const oidc = { issuer: "https://identity.example/", audience: "https://relay.example/mcp", jwksUri: "https://identity.example/jwks", scopes: ["tetherplane:access"], bindings: [{ subject: "owner", clientId: "chatgpt", accountId: "existing-account", principalId: "human:owner" }] };
  try {
    await writeFile(file, JSON.stringify({ oidc }));
    const result = await config.loadClientAuth(file);
    assert.deepEqual(result.oauth, { resource: oidc.audience, issuer: oidc.issuer, scopes: oidc.scopes });
    assert.equal(await result.authenticator.authenticate("not-a-token"), null);
    for (const invalid of [{ oidc, clients: [] }, { oidc: { ...oidc, scopes: [] } }, { oidc: { ...oidc, token: "must-not-appear" } }, { oidc: { ...oidc, issuer: "http://identity.example/" } }]) {
      await writeFile(file, JSON.stringify(invalid));
      await assert.rejects(config.loadClientAuth(file), error => error instanceof Error && !error.message.includes("must-not-appear"));
    }
    await writeFile(file, JSON.stringify({ clients: [{ token_env: "TEST_AUTH", account_id: "a", client_id: "c", principal_id: "p" }] }));
    const legacy = await config.loadClientAuth(file, { TEST_AUTH: "ephemeral-test-value" });
    assert.equal(legacy.oauth, undefined);
    assert.deepEqual(await legacy.authenticator.authenticate("ephemeral-test-value"), { accountId: "a", clientId: "c", principalId: "p" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("CLI accepts subject identity OIDC mode and rejects mixed identity strategies", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oauth-subject-config-"));
  const file = path.join(dir, "auth.json");
  const subjectOidc = {
    issuer: "https://identity.example/",
    audience: "https://relay.example/mcp",
    jwksUri: "https://identity.example/jwks",
    scopes: ["tetherplane:access"],
    identity: {
      strategy: "subject",
      principalPrefix: "human:",
    },
  };

  try {
    await writeFile(file, JSON.stringify({ oidc: subjectOidc }));
    const result = await config.loadClientAuth(file);
    assert.deepEqual(result.oauth, {
      resource: subjectOidc.audience,
      issuer: subjectOidc.issuer,
      scopes: subjectOidc.scopes,
    });
    assert.equal(await result.authenticator.authenticate("not-a-token"), null);

    await writeFile(
      file,
      JSON.stringify({
        oidc: {
          ...subjectOidc,
          bindings: [
            {
              subject: "owner",
              clientId: "chatgpt",
              accountId: "account-a",
              principalId: "human:owner",
            },
          ],
        },
      }),
    );
    await assert.rejects(
      config.loadClientAuth(file),
      /OIDC|identity|binding|strategy/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
