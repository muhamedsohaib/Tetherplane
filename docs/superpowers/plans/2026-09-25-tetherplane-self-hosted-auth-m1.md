# Tetherplane Self-Hosted Identity Milestone 1

**Date:** 2026-09-25
**Branch:** `feature/self-hosted-auth-m1`
**Base:** `feature/fabric-local-model-m1` at `f12fd0c`

## Goal

Remove Auth0 as an architectural dependency without weakening the public MCP OAuth contract.

Tetherplane keeps internal device, worker, and local-agent authentication independent of OAuth. OAuth remains an edge protocol only for external clients such as ChatGPT and Codex.

The relay must continue accepting any conforming OIDC/OAuth authorization server. Tetherplane will provide a self-hosted reference authorization service in a later milestone using an established standards implementation rather than custom protocol/cryptography.

## Current external contract

For authenticated public MCP clients, the authorization path must support:

- OAuth 2.1 authorization-code flow;
- PKCE with S256;
- protected-resource metadata (RFC 9728);
- OAuth/OIDC authorization-server metadata;
- RFC 8707 `resource` on authorization and token requests;
- access tokens bound to the MCP resource through audience/resource validation;
- per-tool OAuth security schemes and runtime auth challenges;
- CIMD, DCR, or predefined OAuth clients;
- refresh/revocation/rotation handled by the authorization server;
- token verification at the relay on every request.

## Architecture

```
ChatGPT / Codex / MCP client
          |
          | OAuth 2.1 + PKCE
          v
Tetherplane-compatible Authorization Server
(self-hosted reference: oidc-provider)
          |
          | short-lived resource-bound token
          v
Tetherplane Relay / MCP edge
          |
          | verified ClientIdentity
          v
Account-scoped device router
          |
          v
local tetherd policy authority
```

Internal paths do not depend on OAuth:

```
local model worker -> local tetherd principal
device agent -> relay pairing/device credential
human local CLI -> local principal binding
```

## Milestone A1 — Dynamic subject identity mapping

The current relay OIDC implementation requires every subject/client pair to be pre-listed in static `bindings`. That cannot scale to a public plugin.

Add a second explicit OIDC identity strategy:

```json
{
  "oidc": {
    "issuer": "https://auth.example.com/",
    "audience": "https://mcp.example.com/mcp",
    "jwksUri": "https://auth.example.com/jwks",
    "scopes": ["tetherplane:access"],
    "identity": {
      "strategy": "subject",
      "principalPrefix": "human:"
    }
  }
}
```

Semantics:

- verified JWT `sub` becomes Tetherplane `accountId`;
- `principalId` becomes `principalPrefix + sub`;
- `clientId` comes from verified `azp` or `client_id`;
- issuer, audience, expiry/not-before, signature, and scopes remain mandatory;
- missing subject/client is rejected;
- explicit static `bindings` mode remains backward-compatible;
- mixing static bindings with subject strategy is rejected.

This trusts only claims from the configured authorization server after cryptographic verification. It does not accept identity claims from MCP request bodies.

## Milestone A2 — Self-hosted provider reference contract

Use an established OpenID-certified authorization-server implementation rather than writing OAuth ourselves.

Reference choice: `oidc-provider`.

Required provider features for the later reference deployment:

- authorization code + PKCE S256;
- RFC 8707 resource indicators;
- refresh tokens and revocation;
- DCR and/or CIMD;
- stable issuer metadata;
- asymmetric signing keys and JWKS;
- persistent adapter/storage;
- explicit login/consent UI;
- no in-memory production key or account storage;
- resource-bound audience matching the MCP endpoint.

Tetherplane relay remains provider-neutral and must not import provider-specific names into canonical capability semantics.

## Milestone A3 — Production operator surfaces

Later tasks:

- reference auth container/deployment;
- persistent database-backed provider adapter;
- account bootstrap/login/consent;
- key rotation;
- provider health/readiness;
- auth observability without token logging;
- domain/TLS deployment docs;
- ChatGPT CIMD/DCR acceptance;
- token refresh/revocation integration tests;
- public plugin review fixtures.

## TDD sequence for A1

1. Add failing OIDC tests for subject identity mapping.
2. Verify failure is specifically missing subject-strategy behavior.
3. Implement minimum verified-claim mapping.
4. Add config-loader tests for subject strategy and mixed-mode rejection.
5. Verify targeted relay tests.
6. Run complete Windows + Ubuntu repository gates.

## Exit proof

- static binding OIDC behavior remains green;
- subject strategy maps only cryptographically verified claims;
- audience/scope/issuer/signature validation remains unchanged;
- no token or secret persistence added;
- OAuth remains isolated to relay edge;
- six MCP tools unchanged;
- full CI green.
