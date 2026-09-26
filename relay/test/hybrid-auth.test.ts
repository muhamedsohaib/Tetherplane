import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";

// TDD RED: hybrid static + OIDC authentication. All signing keys and
// tokens are ephemeral test data and never leave memory except via
// token_env references.

const OIDC_BASE = {
  issuer: "https://identity.example/",
  audience: "https://relay.example/mcp",
  jwksUri: "https://identity.example/.well-known/jwks.json",
  scopes: ["tetherplane:access"],
};

function staticFileContents(tokenEnv: string) {
  return {
    clients: [
      {
        token_env: tokenEnv,
        account_id: "account-static",
        client_id: "static-client",
        principal_id: "human:static",
      },
    ],
  };
}

function oidcFileContents() {
  return {
    oidc: {
      ...OIDC_BASE,
      bindings: [
        {
          subject: "owner",
          clientId: "opencode",
          accountId: "account-oidc",
          principalId: "human:owner",
        },
      ],
    },
  };
}

function hybridFileContents(tokenEnv: string) {
  return {
    clients: [
      {
        token_env: tokenEnv,
        account_id: "account-static",
        client_id: "static-client",
        principal_id: "human:static",
      },
    ],
    oidc: {
      ...OIDC_BASE,
      bindings: [
        {
          subject: "owner",
          clientId: "opencode",
          accountId: "account-oidc",
          principalId: "human:owner",
        },
      ],
    },
  };
}

async function writeAuthFile(
  dir: string,
  name: string,
  contents: unknown,
): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, JSON.stringify(contents), "utf8");
  return file;
}

async function makeOidcHarness() {
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  const keySet = createLocalJWKSet({
    keys: [{ ...jwk, kid: "test" }],
  });
  const claims = {
    iss: OIDC_BASE.issuer,
    aud: OIDC_BASE.audience,
    sub: "owner",
    azp: "opencode",
    scope: "tetherplane:access",
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const sign = (overrides: Record<string, unknown> = {}) =>
    new SignJWT({ ...claims, ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(keys.privateKey);
  return { keys, keySet, claims, sign };
}

test("A. static-only config loads and authenticates exactly as before", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hybrid-a-"));
  try {
    const { loadClientAuth } = await import("../src/cli-config.ts");
    const file = await writeAuthFile(
      dir,
      "auth.json",
      staticFileContents("HYBRID_TEST_STATIC_A"),
    );
    const result = await loadClientAuth(file, {
      HYBRID_TEST_STATIC_A: "static-secret-a",
    });
    assert.equal(result.oauth, undefined);
    assert.deepEqual(
      await result.authenticator.authenticate("static-secret-a"),
      {
        accountId: "account-static",
        clientId: "static-client",
        principalId: "human:static",
      },
    );
    assert.equal(await result.authenticator.authenticate("wrong"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("B. OIDC-only config loads and authenticates exactly as before", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hybrid-b-"));
  try {
    const config = await import("../src/cli-config.ts");
    const file = await writeAuthFile(dir, "auth.json", oidcFileContents());
    const result = await config.loadClientAuth(file);
    assert.deepEqual(result.oauth, {
      resource: OIDC_BASE.audience,
      issuer: OIDC_BASE.issuer,
      scopes: OIDC_BASE.scopes,
    });
    assert.equal(await result.authenticator.authenticate("not-a-token"), null);

    // Direct OIDC token path remains backward compatible.
    const { OidcClientAuthenticator } = await import(
      "../src/auth/oidc-auth.ts"
    );
    const harness = await makeOidcHarness();
    const auth = new OidcClientAuthenticator(
      {
        ...OIDC_BASE,
        bindings: [
          {
            subject: "owner",
            clientId: "opencode",
            accountId: "account-oidc",
            principalId: "human:owner",
          },
        ],
      },
      harness.keySet,
    );
    assert.deepEqual(await auth.authenticate(await harness.sign()), {
      accountId: "account-oidc",
      clientId: "opencode",
      principalId: "human:owner",
    });
    assert.equal(
      await auth.authenticate(
        await harness.sign({ sub: "stranger" }),
      ),
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("C. hybrid static token authenticates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hybrid-c-"));
  try {
    const { loadClientAuth } = await import("../src/cli-config.ts");
    const file = await writeAuthFile(
      dir,
      "auth.json",
      hybridFileContents("HYBRID_TEST_STATIC_C"),
    );
    const result = await loadClientAuth(file, {
      HYBRID_TEST_STATIC_C: "hybrid-static-secret",
    });
    assert.ok(result.oauth);
    assert.deepEqual(
      await result.authenticator.authenticate("hybrid-static-secret"),
      {
        accountId: "account-static",
        clientId: "static-client",
        principalId: "human:static",
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D. hybrid valid OIDC token authenticates with bound identity", async () => {
  const { CompositeClientAuthenticator } = await import(
    "../src/auth/composite-auth.ts"
  );
  const harness = await makeOidcHarness();
  const auth = new CompositeClientAuthenticator({
    staticCredentials: [
      {
        token: "hybrid-static-secret",
        accountId: "account-static",
        clientId: "static-client",
        principalId: "human:static",
      },
    ],
    oidcOptions: {
      ...OIDC_BASE,
      bindings: [
        {
          subject: "owner",
          clientId: "opencode",
          accountId: "account-oidc",
          principalId: "human:owner",
        },
      ],
    },
    oidcKey: harness.keySet,
  });
  assert.deepEqual(await auth.authenticate("hybrid-static-secret"), {
    accountId: "account-static",
    clientId: "static-client",
    principalId: "human:static",
  });
  assert.deepEqual(await auth.authenticate(await harness.sign()), {
    accountId: "account-oidc",
    clientId: "opencode",
    principalId: "human:owner",
  });
});

test("E. hybrid invalid static bearer fails", async () => {
  const { CompositeClientAuthenticator } = await import(
    "../src/auth/composite-auth.ts"
  );
  const harness = await makeOidcHarness();
  const auth = new CompositeClientAuthenticator({
    staticCredentials: [
      {
        token: "hybrid-static-secret",
        accountId: "account-static",
        clientId: "static-client",
        principalId: "human:static",
      },
    ],
    oidcOptions: {
      ...OIDC_BASE,
      bindings: [
        {
          subject: "owner",
          clientId: "opencode",
          accountId: "account-oidc",
          principalId: "human:owner",
        },
      ],
    },
    oidcKey: harness.keySet,
  });
  assert.equal(await auth.authenticate("wrong-static"), null);
  assert.equal(await auth.authenticate(""), null);
});

test("F. hybrid invalid OIDC token fails", async () => {
  const { CompositeClientAuthenticator } = await import(
    "../src/auth/composite-auth.ts"
  );
  const harness = await makeOidcHarness();
  const auth = new CompositeClientAuthenticator({
    staticCredentials: [
      {
        token: "hybrid-static-secret",
        accountId: "account-static",
        clientId: "static-client",
        principalId: "human:static",
      },
    ],
    oidcOptions: {
      ...OIDC_BASE,
      bindings: [
        {
          subject: "owner",
          clientId: "opencode",
          accountId: "account-oidc",
          principalId: "human:owner",
        },
      ],
    },
    oidcKey: harness.keySet,
  });
  assert.equal(await auth.authenticate("malformed"), null);
  assert.equal(
    await auth.authenticate(await harness.sign({ iss: "https://evil.example/" })),
    null,
  );
  assert.equal(
    await auth.authenticate(await harness.sign({ aud: "wrong" })),
    null,
  );
  assert.equal(
    await auth.authenticate(await harness.sign({ exp: 1 })),
    null,
  );
});

test("G. hybrid OIDC valid token with unbound clientId fails", async () => {
  const { CompositeClientAuthenticator } = await import(
    "../src/auth/composite-auth.ts"
  );
  const harness = await makeOidcHarness();
  const auth = new CompositeClientAuthenticator({
    staticCredentials: [
      {
        token: "hybrid-static-secret",
        accountId: "account-static",
        clientId: "static-client",
        principalId: "human:static",
      },
    ],
    oidcOptions: {
      ...OIDC_BASE,
      bindings: [
        {
          subject: "owner",
          clientId: "opencode",
          accountId: "account-oidc",
          principalId: "human:owner",
        },
      ],
    },
    oidcKey: harness.keySet,
  });
  assert.equal(
    await auth.authenticate(await harness.sign({ azp: "unbound-client" })),
    null,
  );
});

test("H. hybrid OIDC valid token with wrong subject fails", async () => {
  const { CompositeClientAuthenticator } = await import(
    "../src/auth/composite-auth.ts"
  );
  const harness = await makeOidcHarness();
  const auth = new CompositeClientAuthenticator({
    staticCredentials: [
      {
        token: "hybrid-static-secret",
        accountId: "account-static",
        clientId: "static-client",
        principalId: "human:static",
      },
    ],
    oidcOptions: {
      ...OIDC_BASE,
      bindings: [
        {
          subject: "owner",
          clientId: "opencode",
          accountId: "account-oidc",
          principalId: "human:owner",
        },
      ],
    },
    oidcKey: harness.keySet,
  });
  assert.equal(
    await auth.authenticate(await harness.sign({ sub: "stranger" })),
    null,
  );
});

test("I. hybrid OIDC valid token missing required scope fails", async () => {
  const { CompositeClientAuthenticator } = await import(
    "../src/auth/composite-auth.ts"
  );
  const harness = await makeOidcHarness();
  const auth = new CompositeClientAuthenticator({
    staticCredentials: [
      {
        token: "hybrid-static-secret",
        accountId: "account-static",
        clientId: "static-client",
        principalId: "human:static",
      },
    ],
    oidcOptions: {
      ...OIDC_BASE,
      bindings: [
        {
          subject: "owner",
          clientId: "opencode",
          accountId: "account-oidc",
          principalId: "human:owner",
        },
      ],
    },
    oidcKey: harness.keySet,
  });
  assert.equal(
    await auth.authenticate(await harness.sign({ scope: "other" })),
    null,
  );
  assert.equal(
    await auth.authenticate(await harness.sign({ scope: "" })),
    null,
  );
});

test("J. malformed hybrid config fails closed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hybrid-j-"));
  try {
    const { loadClientAuth } = await import("../src/cli-config.ts");
    const valid = hybridFileContents("HYBRID_TEST_STATIC_J");
    const cases: Array<[string, unknown]> = [
      ["empty clients", { ...valid, clients: [] }],
      [
        "missing clients token_env",
        {
          ...valid,
          clients: [
            {
              account_id: "a",
              client_id: "c",
              principal_id: "p",
            },
          ],
        },
      ],
      ["empty bindings", { ...valid, oidc: { ...OIDC_BASE, bindings: [] } }],
      ["empty scopes", { ...valid, oidc: { ...OIDC_BASE, scopes: [] } }],
      [
        "http issuer",
        {
          ...valid,
          oidc: { ...OIDC_BASE, issuer: "http://identity.example/" },
        },
      ],
      ["unknown top-level field", { ...valid, extra: 1 }],
      [
        "unknown client field",
        {
          ...valid,
          clients: [
            {
              token_env: "HYBRID_TEST_STATIC_J",
              account_id: "a",
              client_id: "c",
              principal_id: "p",
              extra: 1,
            },
          ],
        },
      ],
      [
        "unknown oidc field",
        { ...valid, oidc: { ...OIDC_BASE, bindings: valid.oidc.bindings, extra: 1 } },
      ],
      ["neither clients nor oidc", { other: 1 }],
      ["empty object", {}],
      ["wildcard subject", { ...valid, oidc: { ...OIDC_BASE, bindings: [{ subject: "*", clientId: "opencode", accountId: "a", principalId: "p" }] } }],
      ["wildcard clientId", { ...valid, oidc: { ...OIDC_BASE, bindings: [{ subject: "owner", clientId: "*", accountId: "a", principalId: "p" }] } }],
    ];
    for (const [name, contents] of cases) {
      const file = await writeAuthFile(
        dir,
        `auth-${name.replace(/[^a-z]+/gi, "-")}.json`,
        contents,
      );
      await assert.rejects(
        loadClientAuth(file, { HYBRID_TEST_STATIC_J: "secret" }),
        /invalid|requires|must|unsupported|unknown|wildcard|duplicate|empty|strict/i,
        name,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("K. raw static token in config remains rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hybrid-k-"));
  try {
    const { loadClientAuth } = await import("../src/cli-config.ts");
    const rawStatic = {
      clients: [
        {
          token: "must-not-be-persisted",
          token_env: "HYBRID_TEST_STATIC_K",
          account_id: "a",
          client_id: "c",
          principal_id: "p",
        },
      ],
    };
    const rawHybrid = {
      ...hybridFileContents("HYBRID_TEST_STATIC_K"),
      clients: [
        {
          token: "must-not-be-persisted",
          token_env: "HYBRID_TEST_STATIC_K",
          account_id: "a",
          client_id: "c",
          principal_id: "p",
        },
      ],
    };
    for (const [name, contents] of [
      ["static", rawStatic],
      ["hybrid", rawHybrid],
    ] as const) {
      const file = await writeAuthFile(dir, `${name}.json`, contents);
      await assert.rejects(
        loadClientAuth(file, { HYBRID_TEST_STATIC_K: "secret" }),
        /raw token/i,
        name,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("L. duplicate/ambiguous identity configuration fails closed", async () => {
  const { CompositeClientAuthenticator } = await import(
    "../src/auth/composite-auth.ts"
  );
  const harness = await makeOidcHarness();
  // Same clientId via static and OIDC must fail even when other fields differ.
  assert.throws(
    () =>
      new CompositeClientAuthenticator({
        staticCredentials: [
          {
            token: "static-secret",
            accountId: "account-a",
            clientId: "shared-client",
            principalId: "human:a",
          },
        ],
        oidcOptions: {
          ...OIDC_BASE,
          bindings: [
            {
              subject: "owner",
              clientId: "shared-client",
              accountId: "account-b",
              principalId: "human:b",
            },
          ],
        },
        oidcKey: harness.keySet,
      }),
    /collision|ambiguous|duplicate|clientId/i,
  );
  // Exact identity triple reuse across trust domains must also fail.
  assert.throws(
    () =>
      new CompositeClientAuthenticator({
        staticCredentials: [
          {
            token: "static-secret",
            accountId: "account-same",
            clientId: "same-client",
            principalId: "human:same",
          },
        ],
        oidcOptions: {
          ...OIDC_BASE,
          bindings: [
            {
              subject: "owner",
              clientId: "same-client",
              accountId: "account-same",
              principalId: "human:same",
            },
          ],
        },
        oidcKey: harness.keySet,
      }),
    /collision|ambiguous|duplicate|clientId/i,
  );
  // Duplicate static bearer secrets are ambiguous.
  const { StaticClientAuthenticator } = await import(
    "../src/auth/static-auth.ts"
  );
  assert.throws(
    () =>
      new StaticClientAuthenticator([
        {
          token: "same-secret",
          accountId: "account-a",
          clientId: "client-a",
          principalId: "human:a",
        },
        {
          token: "same-secret",
          accountId: "account-b",
          clientId: "client-b",
          principalId: "human:b",
        },
      ]),
    /duplicate|collision|ambiguous/i,
  );
  // Hybrid file with colliding clientId must fail closed at load time.
  const dir = await mkdtemp(path.join(os.tmpdir(), "hybrid-l-"));
  try {
    const { loadClientAuth } = await import("../src/cli-config.ts");
    const colliding = {
      clients: [
        {
          token_env: "HYBRID_TEST_STATIC_L",
          account_id: "account-a",
          client_id: "shared-client",
          principal_id: "human:a",
        },
      ],
      oidc: {
        ...OIDC_BASE,
        bindings: [
          {
            subject: "owner",
            clientId: "shared-client",
            accountId: "account-b",
            principalId: "human:b",
          },
        ],
      },
    };
    const file = await writeAuthFile(dir, "auth.json", colliding);
    await assert.rejects(
      loadClientAuth(file, { HYBRID_TEST_STATIC_L: "secret" }),
      /collision|ambiguous|duplicate|clientId/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("M. no token/provider errors appear in logs", async () => {
  const { CompositeClientAuthenticator } = await import(
    "../src/auth/composite-auth.ts"
  );
  const harness = await makeOidcHarness();
  const auth = new CompositeClientAuthenticator({
    staticCredentials: [
      {
        token: "hybrid-static-secret-marker",
        accountId: "account-static",
        clientId: "static-client",
        principalId: "human:static",
      },
    ],
    oidcOptions: {
      ...OIDC_BASE,
      bindings: [
        {
          subject: "owner",
          clientId: "opencode",
          accountId: "account-oidc",
          principalId: "human:owner",
        },
      ],
    },
    oidcKey: harness.keySet,
  });
  const captured: string[] = [];
  const methods = ["log", "error", "warn", "debug"] as const;
  const originals = new Map<string, unknown>();
  const consoleRecord = console as unknown as Record<string, unknown>;
  for (const method of methods) {
    originals.set(method, consoleRecord[method]);
    consoleRecord[method] = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
  }
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stderrCaptured: string[] = [];
  (process.stderr.write as unknown) = ((
    chunk: unknown,
    ...rest: unknown[]
  ): boolean => {
    stderrCaptured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const badOidc = await harness.sign({ sub: "stranger" });
    assert.equal(await auth.authenticate("wrong-static"), null);
    assert.equal(await auth.authenticate("malformed"), null);
    assert.equal(await auth.authenticate(badOidc), null);
    const { loadClientAuth } = await import("../src/cli-config.ts");
    const dir = await mkdtemp(path.join(os.tmpdir(), "hybrid-m-"));
    try {
      const file = await writeAuthFile(dir, "auth.json", {
        oidc: { ...OIDC_BASE, scopes: [] },
      });
      await assert.rejects(loadClientAuth(file));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    for (const method of methods) {
      consoleRecord[method] = originals.get(method);
    }
    process.stderr.write = originalStderrWrite;
  }
  const allOutput = [...captured, ...stderrCaptured].join("\n");
  assert.doesNotMatch(allOutput, /hybrid-static-secret-marker/);
  assert.doesNotMatch(allOutput, /wrong-static/);
  assert.doesNotMatch(allOutput, /malformed/);
  // JWT/provider internals must never be logged.
  assert.doesNotMatch(allOutput, /jwks|jwt|provider|JWKS|JWT/i);
});
