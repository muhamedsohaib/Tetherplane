import assert from "node:assert/strict";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import test from "node:test";

import {
  TetherAuthServer,
} from "../../auth/src/server.ts";
import type {
  TetherAuthInteractionController,
} from "../../auth/src/interaction.ts";

test("tether-auth HTTP interaction routes expose device approval without handling device credentials", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let completed = false;

  const interactions = {
    async beginLogin(
      _request: IncomingMessage,
      _response: ServerResponse,
      interactionUid: string,
    ) {
      calls.push({
        op: "begin",
        interactionUid,
      });
      return {
        userCode: "ABCD-1234",
        expiresAt: "2026-09-25T15:00:00.000Z",
      };
    },
    async completeLogin(
      _request: IncomingMessage,
      response: ServerResponse,
      input: {
        interactionUid: string;
        userCode: string;
      },
    ) {
      calls.push({
        op: "complete",
        ...input,
      });
      if (!completed) {
        return "pending" as const;
      }
      response.statusCode = 302;
      response.setHeader("location", "https://client.example/callback");
      response.end();
      return "completed" as const;
    },
  } satisfies Pick<
    TetherAuthInteractionController,
    "beginLogin" | "completeLogin"
  >;

  const server = new TetherAuthServer({
    providerHandler(_request, response) {
      response.statusCode = 404;
      response.end();
    },
    interactions,
    allowInsecureLocalhost: true,
  });

  try {
    const address = await server.listen({
      host: "127.0.0.1",
      port: 0,
    });

    const started = await fetch(
      `${address.url}/interaction/interaction_123`,
    );
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), {
      status: "pending_device_approval",
      userCode: "ABCD-1234",
      expiresAt: "2026-09-25T15:00:00.000Z",
    });

    const pending = await fetch(
      `${address.url}/interaction/interaction_123/device-login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userCode: "ABCD-1234",
        }),
      },
    );
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), {
      status: "pending_device_approval",
    });

    completed = true;
    const finished = await fetch(
      `${address.url}/interaction/interaction_123/device-login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userCode: "ABCD-1234",
        }),
        redirect: "manual",
      },
    );
    assert.equal(finished.status, 302);
    assert.equal(
      finished.headers.get("location"),
      "https://client.example/callback",
    );

    assert.deepEqual(calls, [
      {
        op: "begin",
        interactionUid: "interaction_123",
      },
      {
        op: "complete",
        interactionUid: "interaction_123",
        userCode: "ABCD-1234",
      },
      {
        op: "complete",
        interactionUid: "interaction_123",
        userCode: "ABCD-1234",
      },
    ]);
  } finally {
    await server.close();
  }
});

test("tether-auth interaction routes reject malformed paths and bodies before controller calls", async () => {
  let calls = 0;
  const interactions = {
    async beginLogin() {
      calls += 1;
      throw new Error("must not run");
    },
    async completeLogin() {
      calls += 1;
      throw new Error("must not run");
    },
  } satisfies Pick<
    TetherAuthInteractionController,
    "beginLogin" | "completeLogin"
  >;

  const server = new TetherAuthServer({
    providerHandler(_request, response) {
      response.statusCode = 404;
      response.end();
    },
    interactions,
    allowInsecureLocalhost: true,
  });

  try {
    const address = await server.listen({
      host: "127.0.0.1",
      port: 0,
    });

    const badPath = await fetch(
      `${address.url}/interaction/../escape`,
      { redirect: "manual" },
    );
    assert.equal(badPath.status, 404);

    const badBody = await fetch(
      `${address.url}/interaction/interaction_123/device-login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userCode: "raw-device-credential",
        }),
      },
    );
    assert.equal(badBody.status, 400);
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});
