import assert from "node:assert/strict";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import test from "node:test";

import {
  callbackOriginForRedirectUri,
  TetherAuthInteractionController,
} from "../../auth/src/interaction.ts";

test("callback origin allows loopback HTTP and HTTPS but nothing else", () => {
  assert.equal(
    callbackOriginForRedirectUri(
      "http://127.0.0.1:8765/callback?code=x",
    ),
    "http://127.0.0.1:8765",
  );
  assert.equal(
    callbackOriginForRedirectUri("http://localhost:8080/cb"),
    "http://localhost:8080",
  );
  assert.equal(
    callbackOriginForRedirectUri("http://[::1]:3000/cb"),
    "http://[::1]:3000",
  );
  assert.equal(
    callbackOriginForRedirectUri(
      "https://app.example.com/oauth/callback",
    ),
    "https://app.example.com",
  );
  assert.equal(
    callbackOriginForRedirectUri("http://evil.example/cb"),
    undefined,
  );
  assert.equal(
    callbackOriginForRedirectUri("http://127.0.0.1.evil.example/"),
    undefined,
  );
  assert.equal(
    callbackOriginForRedirectUri("javascript:alert(1)"),
    undefined,
  );
  assert.equal(
    callbackOriginForRedirectUri("data:text/html,hi"),
    undefined,
  );
  assert.equal(
    callbackOriginForRedirectUri("not a url"),
    undefined,
  );
  assert.equal(
    callbackOriginForRedirectUri(undefined),
    undefined,
  );
  assert.equal(
    callbackOriginForRedirectUri({ toString: "x" }),
    undefined,
  );
});

test("interaction pending state carries the validated callback origin", async () => {
  const controller =
    new TetherAuthInteractionController({
      provider: {
        async interactionDetails() {
          return {
            uid: "interaction_origin",
            prompt: { name: "login" },
            params: {
              redirect_uri: "http://127.0.0.1:8765/callback",
            },
          };
        },
        async interactionFinished() {},
      },
      logins: {
        async start() {
          return {
            userCode: "ABCD-1234",
            expiresAt: "2030-01-01T00:00:00.000Z",
          };
        },
        async consume() {
          return null;
        },
      },
    });
  const request = {} as IncomingMessage;
  const response = {} as ServerResponse;
  assert.deepEqual(
    await controller.beginInteraction(
      request,
      response,
      "interaction_origin",
    ),
    {
      kind: "login",
      userCode: "ABCD-1234",
      expiresAt: "2030-01-01T00:00:00.000Z",
      callbackOrigin: "http://127.0.0.1:8765",
    },
  );
});

test("OIDC login interaction starts device proof and completes with verified account", async () => {
  const starts: string[] = [];
  const consumes: Array<{
    interactionUid: string;
    userCode: string;
  }> = [];
  const finished: Array<unknown> = [];
  let approved = false;

  const controller =
    new TetherAuthInteractionController({
      provider: {
        async interactionDetails() {
          return {
            uid: "interaction_123",
            prompt: { name: "login" },
          };
        },
        async interactionFinished(
          _request,
          _response,
          result,
          options,
        ) {
          finished.push({ result, options });
        },
      },
      logins: {
        async start(input) {
          starts.push(input.interactionUid);
          return {
            userCode: "ABCD-1234",
            expiresAt:
              "2026-09-25T14:00:00.000Z",
          };
        },
        async consume(input) {
          consumes.push(input);
          return approved
            ? { accountId: "account-a" }
            : null;
        },
      },
    });

  const request = {} as IncomingMessage;
  const response = {} as ServerResponse;

  assert.deepEqual(
    await controller.beginLogin(
      request,
      response,
      "interaction_123",
    ),
    {
      userCode: "ABCD-1234",
      expiresAt: "2026-09-25T14:00:00.000Z",
    },
  );
  assert.deepEqual(starts, ["interaction_123"]);

  assert.equal(
    await controller.completeLogin(
      request,
      response,
      {
        interactionUid: "interaction_123",
        userCode: "ABCD-1234",
      },
    ),
    "pending",
  );
  assert.deepEqual(finished, []);

  approved = true;
  assert.equal(
    await controller.completeLogin(
      request,
      response,
      {
        interactionUid: "interaction_123",
        userCode: "ABCD-1234",
      },
    ),
    "completed",
  );

  assert.deepEqual(consumes, [
    {
      interactionUid: "interaction_123",
      userCode: "ABCD-1234",
    },
    {
      interactionUid: "interaction_123",
      userCode: "ABCD-1234",
    },
  ]);
  assert.deepEqual(finished, [
    {
      result: {
        login: {
          accountId: "account-a",
        },
      },
      options: {
        mergeWithLastSubmission: false,
      },
    },
  ]);
});

test("OIDC device login rejects cross-interaction and non-login prompts before relay proof calls", async () => {
  let proofCalls = 0;
  const controller =
    new TetherAuthInteractionController({
      provider: {
        async interactionDetails() {
          return {
            uid: "interaction_real",
            prompt: { name: "consent" },
          };
        },
        async interactionFinished() {
          throw new Error(
            "interaction must not finish",
          );
        },
      },
      logins: {
        async start() {
          proofCalls += 1;
          throw new Error(
            "proof start must not run",
          );
        },
        async consume() {
          proofCalls += 1;
          throw new Error(
            "proof consume must not run",
          );
        },
      },
    });

  const request = {} as IncomingMessage;
  const response = {} as ServerResponse;

  await assert.rejects(
    controller.beginLogin(
      request,
      response,
      "interaction_other",
    ),
    /interaction/i,
  );

  await assert.rejects(
    controller.beginLogin(
      request,
      response,
      "interaction_real",
    ),
    /login/i,
  );

  assert.equal(proofCalls, 0);
});
