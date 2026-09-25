import assert from "node:assert/strict";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import test from "node:test";

import {
  TetherAuthServer,
} from "../../auth/src/server.ts";

test("tether-auth presents consent before explicit confirmation and then resumes OIDC", async () => {
  const resource = "https://mcp.example.com/mcp";
  const calls: string[] = [];

  const server = new TetherAuthServer({
    providerHandler(_request, response) {
      response.statusCode = 404;
      response.end();
    },
    interactions: {
      async beginLogin() {
        throw new Error(
          "legacy login path must not run",
        );
      },
      async completeLogin() {
        throw new Error(
          "login completion must not run",
        );
      },
      async beginInteraction(
        _request: IncomingMessage,
        _response: ServerResponse,
        interactionUid: string,
      ) {
        calls.push(
          `begin:${interactionUid}`,
        );
        return {
          kind: "consent" as const,
          clientId: "client-a",
          oidcScopes: ["openid"],
          resourceScopes: [
            {
              resource,
              scopes: [
                "tetherplane:access",
              ],
            },
          ],
        };
      },
      async completeConsent(
        _request: IncomingMessage,
        response: ServerResponse,
        interactionUid: string,
      ) {
        calls.push(
          `consent:${interactionUid}`,
        );
        response.statusCode = 302;
        response.setHeader(
          "location",
          "https://client.example/callback",
        );
        response.end();
        return "completed" as const;
      },
    },
    allowInsecureLocalhost: true,
  });

  try {
    const address = await server.listen({
      host: "127.0.0.1",
      port: 0,
    });

    const described = await fetch(
      `${address.url}/interaction/interaction_123`,
    );
    assert.equal(described.status, 200);
    assert.deepEqual(
      await described.json(),
      {
        status: "awaiting_consent",
        clientId: "client-a",
        oidcScopes: ["openid"],
        resourceScopes: [
          {
            resource,
            scopes: [
              "tetherplane:access",
            ],
          },
        ],
      },
    );
    assert.deepEqual(calls, [
      "begin:interaction_123",
    ]);

    const confirmed = await fetch(
      `${address.url}/interaction/interaction_123/consent`,
      {
        method: "POST",
        redirect: "manual",
      },
    );
    assert.equal(confirmed.status, 302);
    assert.equal(
      confirmed.headers.get("location"),
      "https://client.example/callback",
    );
    assert.deepEqual(calls, [
      "begin:interaction_123",
      "consent:interaction_123",
    ]);
  } finally {
    await server.close();
  }
});

test("GET consent description never mutates a grant", async () => {
  let completions = 0;
  const server = new TetherAuthServer({
    providerHandler(_request, response) {
      response.statusCode = 404;
      response.end();
    },
    interactions: {
      async beginLogin() {
        throw new Error("must not run");
      },
      async completeLogin() {
        throw new Error("must not run");
      },
      async beginInteraction() {
        return {
          kind: "consent" as const,
          clientId: "client-a",
          oidcScopes: [],
          resourceScopes: [],
        };
      },
      async completeConsent() {
        completions += 1;
        return "completed" as const;
      },
    },
    allowInsecureLocalhost: true,
  });

  try {
    const address = await server.listen({
      host: "127.0.0.1",
      port: 0,
    });
    const response = await fetch(
      `${address.url}/interaction/interaction_456`,
    );
    assert.equal(response.status, 200);
    assert.equal(completions, 0);
  } finally {
    await server.close();
  }
});
