import assert from "node:assert/strict";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import test from "node:test";

import {
  TetherAuthInteractionController,
} from "../../auth/src/interaction.ts";

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
