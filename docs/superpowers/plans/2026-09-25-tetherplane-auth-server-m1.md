# Tetherplane Auth Server Milestone 1

**Date:** 2026-09-25
**Branch:** `feature/tether-auth-server-m1`
**Base:** `feature/self-hosted-auth-m1` at `53b6e99`

## Goal

Add a self-hosted OAuth/OIDC authorization-server service that removes Auth0 as an operational dependency while preserving Tetherplane's provider-neutral relay contract.

This service is an edge identity component, not part of the Capability Kernel and not an authority over local device policy.

## Architecture

```
ChatGPT / Codex / MCP client
        |
        | OAuth 2.1 + PKCE S256 + resource
        v
tether-auth
(self-hosted authorization server)
        |
        | short-lived signed access token
        v
tether-relay
        |
        v
local tetherd final policy authority
```

Local-model workers and paired devices do not depend on OAuth.

## Reference implementation

Use `oidc-provider` pinned to `9.12.2`.

Reasons:
- OpenID Certified authorization-server implementation;
- OAuth 2.0/OIDC metadata;
- PKCE;
- RFC 8707 resource indicators;
- refresh tokens and revocation;
- dynamic client registration;
- current Node 22 support.

Tetherplane must not implement OAuth cryptography or token protocol handling itself.

## Task A2.1 — Pure configuration contract

Add a provider-neutral Tetherplane auth configuration builder before wiring the dependency.

Requirements:
- HTTPS issuer in production;
- canonical MCP resource URL;
- only the `tetherplane:access` resource scope for the first milestone;
- PKCE required and S256 only;
- RFC 8707 resource indicators enabled;
- unknown resource indicators rejected;
- access tokens issued as JWTs for the MCP resource;
- refresh token rotation/revocation delegated to oidc-provider;
- DCR enabled explicitly;
- no implicit grant;
- no password grant;
- interaction URL remains under Tetherplane-controlled routes;
- signing keys and adapter supplied by the deployment, never generated into source.

## Task A2.2 — Runnable authorization service

Add `auth/` workspace package with:
- exact `oidc-provider@9.12.2` dependency;
- Node 22 runtime;
- server bootstrap;
- `/healthz` and `/readyz`;
- provider discovery/JWKS endpoints;
- clean SIGINT/SIGTERM shutdown;
- no secret logging.

Production service must refuse:
- plaintext non-loopback binding;
- missing signing keys;
- missing persistent adapter;
- in-memory production account/session storage.

## Task A2.3 — Device-assisted interaction boundary

Do not add a username/password database.

First login flow:
1. OAuth interaction is created by oidc-provider.
2. User proves ownership through an already paired Tetherplane device/account.
3. The interaction is completed for that Tetherplane account ID.
4. Consent grants only the requested MCP resource/scope.
5. No device credential is exposed to the browser or OAuth client.

The exact proof transport will be designed against existing DeviceRegistry primitives before implementation.

## TDD order

1. RED config-contract tests.
2. GREEN pure config builder.
3. RED runnable-service tests.
4. Add dependency + generated lockfile.
5. GREEN server bootstrap and health.
6. RED device-login proof contract.
7. GREEN minimum device-assisted interaction boundary.
8. Full Ubuntu + Windows gates.

## Exit proof for Milestone 1

- Auth0 is not required for self-hosted deployment.
- Relay remains compatible with external conforming OIDC providers.
- Six MCP tools unchanged.
- Local tetherd remains final authority.
- OAuth server uses exact pinned standards dependency.
- PKCE S256 + RFC 8707 are enforced.
- CI green on Ubuntu and Windows.
