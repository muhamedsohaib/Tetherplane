import assert from "node:assert/strict";
import test from "node:test";

import { createTetherAuthConfiguration } from "../../auth/src/config.ts";

test("tether-auth configuration enforces PKCE S256 and the canonical MCP resource", async () => {
  const resource = "https://mcp.example.com/mcp";
  const config = createTetherAuthConfiguration({
    issuer: "https://auth.example.com/",
    resource,
    interactionBasePath: "/interaction",
    invalidTarget: () => new Error("invalid_target"),
  });

  assert.deepEqual(config.pkce?.methods, ["S256"]);
  assert.equal(config.pkce?.required?.({} as never, {} as never), true);
  assert.equal(config.features?.registration?.enabled, true);
  assert.equal(config.features?.resourceIndicators?.enabled, true);

  const info = await config.features?.resourceIndicators?.getResourceServerInfo?.(
    {} as never,
    resource,
    {} as never,
  );
  assert.deepEqual(info, {
    audience: resource,
    scope: "tetherplane:access",
    accessTokenFormat: "jwt",
    accessTokenTTL: 600,
  });

  await assert.rejects(
    async () =>
      config.features?.resourceIndicators?.getResourceServerInfo?.(
        {} as never,
        "https://other.example/mcp",
        {} as never,
      ),
    /invalid_target/,
  );

  assert.equal(
    config.interactions?.url?.({} as never, { uid: "abc123" } as never),
    "/interaction/abc123",
  );
});

test("tether-auth configuration rejects unsafe production issuer/resource inputs", () => {
  const base = {
    issuer: "https://auth.example.com/",
    resource: "https://mcp.example.com/mcp",
    interactionBasePath: "/interaction",
    invalidTarget: () => new Error("invalid_target"),
  };

  assert.throws(
    () => createTetherAuthConfiguration({ ...base, issuer: "http://auth.example.com/" }),
    /issuer.*https/i,
  );
  assert.throws(
    () => createTetherAuthConfiguration({ ...base, resource: "http://mcp.example.com/mcp" }),
    /resource.*https/i,
  );
  assert.throws(
    () => createTetherAuthConfiguration({ ...base, resource: "https://mcp.example.com/not-mcp" }),
    /resource.*\/mcp/i,
  );
});
