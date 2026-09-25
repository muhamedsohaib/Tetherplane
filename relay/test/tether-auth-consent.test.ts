import assert from "node:assert/strict";
import type {
  IncomingMessage,
  ServerResponse,
} from "node:http";
import test from "node:test";

import {
  TetherAuthInteractionController,
} from "../../auth/src/interaction.ts";

test("OIDC consent grants only configured Tetherplane resource scopes after explicit confirmation", async () => {
  const resource = "https://mcp.example.com/mcp";
  const grantOps: Array<unknown> = [];
  const finished: Array<unknown> = [];

  const grant = {
    addOIDCScope(scope: string) {
      grantOps.push({
        op: "oidc",
        scope,
      });
    },
    addResourceScope(
      indicator: string,
      scope: string,
    ) {
      grantOps.push({
        op: "resource",
        indicator,
        scope,
      });
    },
    async save() {
      grantOps.push({ op: "save" });
      return "grant-123";
    },
  };

  const controller =
    new TetherAuthInteractionController({
      provider: {
        async interactionDetails() {
          return {
            uid: "interaction_123",
            prompt: {
              name: "consent",
              details: {
                missingOIDCScope: ["openid"],
                missingResourceScopes: {
                  [resource]: [
                    "tetherplane:access",
                  ],
                },
              },
            },
            params: {
              client_id: "client-a",
            },
            session: {
              accountId: "account-a",
            },
          } as never;
        },
        async interactionFinished(
          _request,
          _response,
          result,
          options,
        ) {
          finished.push({
            result,
            options,
          });
        },
      },
      logins: {
        async start() {
          throw new Error(
            "login proof must not run during consent",
          );
        },
        async consume() {
          throw new Error(
            "login proof must not run during consent",
          );
        },
      },
      resource,
      grants: {
        async find() {
          return null;
        },
        create(input) {
          grantOps.push({
            op: "create",
            input,
          });
          return grant;
        },
      },
    });

  const request = {} as IncomingMessage;
  const response = {} as ServerResponse;

  assert.deepEqual(
    await controller.describeConsent(
      request,
      response,
      "interaction_123",
    ),
    {
      clientId: "client-a",
      oidcScopes: ["openid"],
      resourceScopes: [
        {
          resource,
          scopes: ["tetherplane:access"],
        },
      ],
    },
  );

  assert.equal(
    await controller.completeConsent(
      request,
      response,
      "interaction_123",
    ),
    "completed",
  );

  assert.deepEqual(grantOps, [
    {
      op: "create",
      input: {
        accountId: "account-a",
        clientId: "client-a",
      },
    },
    {
      op: "oidc",
      scope: "openid",
    },
    {
      op: "resource",
      indicator: resource,
      scope: "tetherplane:access",
    },
    { op: "save" },
  ]);
  assert.deepEqual(finished, [
    {
      result: {
        consent: {
          grantId: "grant-123",
        },
      },
      options: {
        mergeWithLastSubmission: true,
      },
    },
  ]);
});

test("OIDC consent rejects unknown resources, scopes, claims, and RAR before grant mutation", async () => {
  const resource = "https://mcp.example.com/mcp";
  let grantCalls = 0;
  let finished = 0;
  const unsafeDetails = [
    {
      missingResourceScopes: {
        "https://other.example/mcp": [
          "tetherplane:access",
        ],
      },
    },
    {
      missingResourceScopes: {
        [resource]: ["admin"],
      },
    },
    {
      missingOIDCScope: ["profile"],
    },
    {
      missingOIDCClaims: ["email"],
    },
    {
      rar: [{ type: "arbitrary" }],
    },
  ];

  for (const details of unsafeDetails) {
    const controller =
      new TetherAuthInteractionController({
        provider: {
          async interactionDetails() {
            return {
              uid: "interaction_unsafe",
              prompt: {
                name: "consent",
                details,
              },
              params: {
                client_id: "client-a",
              },
              session: {
                accountId: "account-a",
              },
            } as never;
          },
          async interactionFinished() {
            finished += 1;
          },
        },
        logins: {
          async start() {
            throw new Error(
              "login proof must not run",
            );
          },
          async consume() {
            throw new Error(
              "login proof must not run",
            );
          },
        },
        resource,
        grants: {
          async find() {
            grantCalls += 1;
            return null;
          },
          create() {
            grantCalls += 1;
            throw new Error(
              "grant creation must not run",
            );
          },
        },
      });

    await assert.rejects(
      controller.completeConsent(
        {} as IncomingMessage,
        {} as ServerResponse,
        "interaction_unsafe",
      ),
      /consent|resource|scope|claim|RAR/i,
    );
  }

  assert.equal(grantCalls, 0);
  assert.equal(finished, 0);
});
