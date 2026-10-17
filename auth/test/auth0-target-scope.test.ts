import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

type ActionEvent = {
  secrets?: {
    TETHERPLANE_RESOURCE?: unknown;
    TETHERPLANE_BINDINGS_JSON?: unknown;
  };
  resource_server?: { identifier?: unknown };
  user?: { user_id?: unknown };
  client?: { client_id?: unknown };
  transaction?: {
    protocol?: unknown;
    requested_scopes?: unknown;
    target_scopes?: unknown;
  };
};

type ActionApi = {
  access?: { deny?(message: string): void };
  transaction?: {
    addTargetScope?(scope: string): void;
    setTargetScopes?(scopes: string[]): void;
    removeTargetScope?(scope: string): void;
  };
  accessToken?: { addScope?(scope: string): void };
};

const action = require("../examples/auth0-target-scope.cjs") as {
  onExecutePostLogin(event: ActionEvent | undefined, api: ActionApi): Promise<void>;
};

function enrolledEvent(): ActionEvent {
  return {
    secrets: {
      TETHERPLANE_RESOURCE: "https://relay.example/mcp",
      TETHERPLANE_BINDINGS_JSON: JSON.stringify([
        { subject: "auth0|owner", clientId: "tpc_enrolled_fixture" },
      ]),
    },
    resource_server: { identifier: "https://relay.example/mcp" },
    user: { user_id: "auth0|owner" },
    client: { client_id: "tpc_enrolled_fixture" },
    transaction: {
      protocol: "oidc-basic-profile",
      requested_scopes: ["openid", "profile"],
      target_scopes: ["openid", "profile"],
    },
  };
}

// The hosted Auth0 API is the only double. These tests exercise the real
// handler's target-scope request and guards, not consent or token issuance.
function hostedApi(event: ActionEvent | undefined) {
  const addedScopes: string[] = [];
  const denials: string[] = [];
  const forbiddenCalls: string[] = [];
  const api: ActionApi = {
    access: { deny(message) { denials.push(message); } },
    transaction: {
      addTargetScope(scope) {
        addedScopes.push(scope);
        assert.ok(event?.transaction);
        const targetScopes = event.transaction.target_scopes;
        if (targetScopes === undefined) {
          event.transaction.target_scopes = [scope];
        } else {
          assert.ok(Array.isArray(targetScopes));
          if (!targetScopes.includes(scope)) targetScopes.push(scope);
        }
      },
      setTargetScopes() { forbiddenCalls.push("set"); },
      removeTargetScope() { forbiddenCalls.push("remove"); },
    },
    accessToken: { addScope() { forbiddenCalls.push("force-add"); } },
  };
  return { api, addedScopes, denials, forbiddenCalls };
}

function assertDenied(fixture: ReturnType<typeof hostedApi>) {
  assert.deepEqual(fixture.addedScopes, []);
  assert.deepEqual(fixture.forbiddenCalls, []);
  assert.equal(fixture.denials.length, 1);
  assert.match(fixture.denials[0]!, /Tetherplane.*(unavailable|denied)/i);
  for (const value of ["auth0|owner", "tpc_enrolled_fixture", "https://relay.example/mcp"]) {
    assert.ok(!fixture.denials[0]!.includes(value));
  }
}

function assertNoop(fixture: ReturnType<typeof hostedApi>) {
  assert.deepEqual(fixture.addedScopes, []);
  assert.deepEqual(fixture.denials, []);
  assert.deepEqual(fixture.forbiddenCalls, []);
}

test("Auth0 scope recovery exports the Post Login handler", () => {
  assert.equal(typeof action.onExecutePostLogin, "function");
});

test("enrolled authorization code flow requests only the missing target scope", async () => {
  const event = enrolledEvent();
  event.transaction!.target_scopes = ["openid", "profile", "other:read"];
  const before = structuredClone(event);
  const fixture = hostedApi(event);
  await action.onExecutePostLogin(event, fixture.api);
  assert.deepEqual(fixture.addedScopes, ["tetherplane:access"]);
  assert.deepEqual(fixture.denials, []);
  assert.deepEqual(fixture.forbiddenCalls, []);
  assert.deepEqual(event, {
    ...before,
    transaction: {
      ...before.transaction,
      target_scopes: ["openid", "profile", "other:read", "tetherplane:access"],
    },
  });
});

test("enrolled refresh flow requests the target scope through provider authorization", async () => {
  const event = enrolledEvent();
  event.transaction!.protocol = "oauth2-refresh-token";
  const before = structuredClone(event);
  const fixture = hostedApi(event);
  await action.onExecutePostLogin(event, fixture.api);
  assert.deepEqual(fixture.addedScopes, ["tetherplane:access"]);
  assert.deepEqual(fixture.denials, []);
  assert.deepEqual(fixture.forbiddenCalls, []);
  assert.deepEqual(event, {
    ...before,
    transaction: { ...before.transaction, target_scopes: ["openid", "profile", "tetherplane:access"] },
  });
});

test("existing target scope is a no-op and retains all other target scopes", async () => {
  const event = enrolledEvent();
  event.transaction!.target_scopes = ["openid", "profile", "tetherplane:access", "other:read"];
  const before = structuredClone(event);
  const fixture = hostedApi(event);
  await action.onExecutePostLogin(event, fixture.api);
  assert.deepEqual(fixture.addedScopes, []);
  assert.deepEqual(fixture.denials, []);
  assert.deepEqual(fixture.forbiddenCalls, []);
  assert.deepEqual(event, before);
});

test("initial requested scope does not hide removal from the live target set", async () => {
  const event = enrolledEvent();
  event.transaction!.requested_scopes = ["openid", "tetherplane:access"];
  const before = structuredClone(event);
  const fixture = hostedApi(event);
  await action.onExecutePostLogin(event, fixture.api);
  assert.deepEqual(fixture.addedScopes, ["tetherplane:access"]);
  assert.deepEqual(fixture.denials, []);
  assert.deepEqual(event, {
    ...before,
    transaction: { ...before.transaction, target_scopes: ["openid", "profile", "tetherplane:access"] },
  });
});

test("repeated execution observes the live scope and requests it only once", async () => {
  const event = enrolledEvent();
  const before = structuredClone(event);
  const fixture = hostedApi(event);
  await action.onExecutePostLogin(event, fixture.api);
  await action.onExecutePostLogin(event, fixture.api);
  assert.deepEqual(fixture.addedScopes, ["tetherplane:access"]);
  assert.deepEqual(fixture.denials, []);
  assert.deepEqual(fixture.forbiddenCalls, []);
  assert.deepEqual(event, {
    ...before,
    transaction: { ...before.transaction, target_scopes: ["openid", "profile", "tetherplane:access"] },
  });
});

test("resource comparison is exact and unrelated resources remain unaffected", async (t) => {
  for (const resource of [
    "https://other.example/mcp",
    "https://relay.example/mcp/",
    "https://relay.example/mcp?other=1",
    undefined,
  ]) {
    await t.test(resource === undefined ? "no resource" : "different exact resource", async () => {
      const event = enrolledEvent();
      event.resource_server = { identifier: resource };
      event.secrets!.TETHERPLANE_BINDINGS_JSON = "invalid-json";
      event.transaction!.protocol = "oauth2-token-exchange-federated-connection";
      const before = structuredClone(event);
      const fixture = hostedApi(event);
      await action.onExecutePostLogin(event, fixture.api);
      assert.deepEqual(fixture.addedScopes, []);
      assert.deepEqual(fixture.denials, []);
      assert.deepEqual(fixture.forbiddenCalls, []);
      assert.deepEqual(event, before);
    });
  }
});

test("unenrolled or missing subject-client identity leaves existing authorization unchanged", async (t) => {
  for (const [name, userId, clientId] of [
    ["different subject", "auth0|stranger", "tpc_enrolled_fixture"],
    ["replacement client", "auth0|owner", "tpc_replacement_fixture"],
    ["prefix is not enrollment", "auth0|owner", "tpc_enrolled_fixture_extra"],
    ["missing subject", undefined, "tpc_enrolled_fixture"],
    ["missing client", "auth0|owner", undefined],
  ]) {
    await t.test(name!, async () => {
      const event = enrolledEvent();
      event.user = { user_id: userId };
      event.client = { client_id: clientId };
      event.transaction!.target_scopes = ["tetherplane:access"];
      const before = structuredClone(event);
      const fixture = hostedApi(event);
      await action.onExecutePostLogin(event, fixture.api);
      assertNoop(fixture);
      assert.deepEqual(event, before);
    });
  }
});

test("missing or invalid resource configuration is a no-op without a scope grant", async (t) => {
  for (const resource of [
    undefined, null, "", " ", "http://relay.example/mcp", "https://relay.example/other",
    "https://relay.example/mcp?query=1", "https://relay.example/mcp#fragment",
    "https://operator@relay.example/mcp", "https://relay.example/mcp ",
  ]) {
    await t.test("invalid configured resource", async () => {
      const event = enrolledEvent();
      event.secrets!.TETHERPLANE_RESOURCE = resource;
      const before = structuredClone(event);
      const fixture = hostedApi(event);
      await action.onExecutePostLogin(event, fixture.api);
      assertNoop(fixture);
      assert.deepEqual(event, before);
    });
  }
  for (const event of [undefined, {}, { resource_server: { identifier: "https://other.example/mcp" } }]) {
    const before = structuredClone(event);
    const fixture = hostedApi(event);
    await action.onExecutePostLogin(event, fixture.api);
    assertNoop(fixture);
    assert.deepEqual(event, before);
  }
});

test("malformed, empty or wildcard enrollment is a no-op without a scope grant", async (t) => {
  for (const [name, bindings] of [
    ["missing", undefined], ["invalid JSON", "invalid-json"], ["not an array", "{}"],
    ["empty", "[]"], ["null entry", "[null]"],
    ["subject wildcard", '[{"subject":"auth0|*","clientId":"tpc_enrolled_fixture"}]'],
    ["client wildcard", '[{"subject":"auth0|owner","clientId":"*"}]'],
    ["partial wildcard", '[{"subject":"auth0|owner","clientId":"tpc_*"}]'],
    ["missing client", '[{"subject":"auth0|owner"}]'],
    ["numeric client", '[{"subject":"auth0|owner","clientId":1}]'],
    ["extra field", '[{"subject":"auth0|owner","clientId":"tpc_enrolled_fixture","all":true}]'],
    ["blank subject", '[{"subject":" ","clientId":"tpc_enrolled_fixture"}]'],
    ["invalid entry alongside enrolled pair", '[{"subject":"auth0|owner","clientId":"tpc_enrolled_fixture"},{"subject":"*","clientId":"*"}]'],
  ] as Array<[string, unknown]>) {
    await t.test(name, async () => {
      const event = enrolledEvent();
      event.secrets!.TETHERPLANE_BINDINGS_JSON = bindings;
      const before = structuredClone(event);
      const fixture = hostedApi(event);
      await action.onExecutePostLogin(event, fixture.api);
      assertNoop(fixture);
      assert.deepEqual(event, before);
    });
  }
});

test("missing target API denies without falling back to token force-add", async (t) => {
  for (const presentScope of [false, true]) {
    await t.test(presentScope ? "scope already present" : "scope absent", async () => {
      const event = enrolledEvent();
      if (presentScope) event.transaction!.target_scopes = ["tetherplane:access"];
      const fixture = hostedApi(event);
      delete fixture.api.transaction!.addTargetScope;
      await action.onExecutePostLogin(event, fixture.api);
      assertDenied(fixture);
    });
  }
});

test("unavailable transaction API denies the configured resource", async () => {
  const event = enrolledEvent();
  const fixture = hostedApi(event);
  delete fixture.api.transaction;
  await action.onExecutePostLogin(event, fixture.api);
  assertDenied(fixture);
});

test("unsupported or missing flow denies before target-scope mutation", async (t) => {
  for (const protocol of [
    "oauth2-token-exchange-federated-connection", "samlp", "wsfed", "oidc-ciba",
    "unrecognized", undefined,
  ]) {
    await t.test(protocol ?? "missing protocol", async () => {
      const event = enrolledEvent();
      event.transaction!.protocol = protocol;
      const fixture = hostedApi(event);
      await action.onExecutePostLogin(event, fixture.api);
      assertDenied(fixture);
    });
  }
});

test("missing live target scopes remains additive rather than replacing scopes", async () => {
  const event = enrolledEvent();
  delete event.transaction!.target_scopes;
  const before = structuredClone(event);
  const fixture = hostedApi(event);
  await action.onExecutePostLogin(event, fixture.api);
  assert.deepEqual(fixture.addedScopes, ["tetherplane:access"]);
  assert.deepEqual(fixture.denials, []);
  assert.deepEqual(fixture.forbiddenCalls, []);
  assert.deepEqual(event, {
    ...before,
    transaction: { ...before.transaction, target_scopes: ["tetherplane:access"] },
  });
});

test("malformed live target scopes denies the configured resource", async () => {
  const event = enrolledEvent();
  event.transaction!.target_scopes = "tetherplane:access";
  const fixture = hostedApi(event);
  await action.onExecutePostLogin(event, fixture.api);
  assertDenied(fixture);
});

test("target API failures deny with a generic message", async () => {
  const event = enrolledEvent();
  const fixture = hostedApi(event);
  fixture.api.transaction!.addTargetScope = () => { throw new Error("private-provider-detail"); };
  await action.onExecutePostLogin(event, fixture.api);
  assertDenied(fixture);
  assert.ok(!fixture.denials[0]!.includes("private-provider-detail"));
});

test("absence of the deny API cannot silently allow a rejected flow", async () => {
  const event = enrolledEvent();
  event.transaction!.protocol = "samlp";
  const fixture = hostedApi(event);
  delete fixture.api.access;
  await assert.rejects(action.onExecutePostLogin(event, fixture.api), /Tetherplane.*(unavailable|denied)/i);
  assert.deepEqual(fixture.addedScopes, []);
  assert.deepEqual(fixture.forbiddenCalls, []);
});

test("unenrolled clients do not depend on the recovery runtime API", async () => {
  const event = enrolledEvent();
  event.client!.client_id = "tpc_existing_unenrolled_fixture";
  event.transaction!.protocol = "samlp";
  event.transaction!.target_scopes = "tetherplane:access";
  const before = structuredClone(event);
  await action.onExecutePostLogin(event, {});
  assert.deepEqual(event, before);
});

test("missing resource configuration leaves unrelated flows unchanged", async () => {
  const event = enrolledEvent();
  delete event.secrets!.TETHERPLANE_RESOURCE;
  event.resource_server!.identifier = "https://unrelated.example/api";
  const before = structuredClone(event);
  const fixture = hostedApi(event);
  await action.onExecutePostLogin(event, fixture.api);
  assertNoop(fixture);
  assert.deepEqual(event, before);
});
