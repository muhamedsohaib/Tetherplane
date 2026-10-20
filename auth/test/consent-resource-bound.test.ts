import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

import {
  TetherAuthInteractionController,
  type TetherAuthConsentDetails,
} from "../src/interaction.ts";

const RESOURCE = "https://relay.example.test/mcp";
const UID = "interaction_fixture123";

function harness(details: TetherAuthConsentDetails) {
  const changes: Array<Record<string, unknown>> = [];
  const controller = new TetherAuthInteractionController({
    provider: {
      async interactionDetails() {
        return {
          uid: UID,
          prompt: { name: "consent", details },
          params: { client_id: "known-client" },
          session: { accountId: "paired-account" },
        };
      },
      async interactionFinished(_request, _response, result) {
        changes.push({ action: "finished", result });
      },
    },
    logins: {
      async start() { throw new Error("device proof must not start during consent"); },
      async consume() { throw new Error("device proof must not be consumed during consent"); },
    },
    resource: RESOURCE,
    grants: {
      async find() { throw new Error("unexpected grant lookup"); },
      create(input) {
        changes.push({ action: "create", input });
        return {
          addOIDCScope(scope) { changes.push({ action: "oidc", scope }); },
          addResourceScope(resource, scope) {
            changes.push({ action: "resource", resource, scope });
          },
          async save() {
            changes.push({ action: "save" });
            return "grant_fixture123";
          },
        };
      },
    },
  });
  return {
    controller,
    changes,
    request: {} as IncomingMessage,
    response: {} as ServerResponse,
  };
}

test("duplicate generic OIDC access is denied even alongside canonical resource scope", async () => {
  const state = harness({
    missingOIDCScope: ["openid", "tetherplane:access"],
    missingResourceScopes: { [RESOURCE]: ["tetherplane:access"] },
  });
  await assert.rejects(
    state.controller.describeConsent(state.request, state.response, UID),
    /unsupported scope/i,
  );
  await assert.rejects(
    state.controller.completeConsent(state.request, state.response, UID),
    /unsupported scope/i,
  );
  assert.deepEqual(state.changes, [], "a generic access scope must never create a grant");
});

test("standalone access scope without matching canonical resource fails closed before grant mutation", async () => {
  const unsafe: Array<{ label: string; details: TetherAuthConsentDetails }> = [
    {
      label: "access without resource",
      details: { missingOIDCScope: ["openid", "tetherplane:access"] },
    },
    {
      label: "access with empty resource request",
      details: { missingOIDCScope: ["tetherplane:access"], missingResourceScopes: {} },
    },
    {
      label: "access with wrong resource",
      details: {
        missingOIDCScope: ["tetherplane:access"],
        missingResourceScopes: { "https://foreign.example.test/mcp": ["tetherplane:access"] },
      },
    },
    {
      label: "access with canonical resource but no access grant",
      details: {
        missingOIDCScope: ["tetherplane:access"],
        missingResourceScopes: { [RESOURCE]: [] },
      },
    },
    {
      label: "access with unsupported resource scope",
      details: {
        missingOIDCScope: ["tetherplane:access"],
        missingResourceScopes: { [RESOURCE]: ["admin"] },
      },
    },
    {
      label: "access accompanied by a forbidden OIDC permission",
      details: {
        missingOIDCScope: ["openid", "profile", "tetherplane:access"],
        missingResourceScopes: { [RESOURCE]: ["tetherplane:access"] },
      },
    },
  ];
  for (const entry of unsafe) {
    const state = harness(entry.details);
    await assert.rejects(
      state.controller.describeConsent(state.request, state.response, UID),
      /scope|resource/i,
      entry.label,
    );
    await assert.rejects(
      state.controller.completeConsent(state.request, state.response, UID),
      /scope|resource/i,
      entry.label,
    );
    assert.deepEqual(state.changes, [], entry.label + ": denied requests must not create grants");
  }
});

test("resource-only canonical access works without OIDC-scope duplication", async () => {
  const state = harness({
    missingOIDCScope: ["openid"],
    missingResourceScopes: { [RESOURCE]: ["tetherplane:access"] },
  });
  const result = await state.controller.describeConsent(state.request, state.response, UID);
  assert.deepEqual(result.oidcScopes, ["openid"]);
  assert.deepEqual(result.resourceScopes, [{ resource: RESOURCE, scopes: ["tetherplane:access"] }]);
  assert.deepEqual(state.changes, []);
});
