# Tetherplane Auth Production A3

**Date:** 2026-09-26
**Branch:** `feature/tether-auth-production-a3`
**Base:** `main` at `b9fbbb5f`

## Goal

Turn the self-hosted `tether-auth` milestone into a production-operable reference deployment without changing Tetherplane's provider-neutral relay contract or local-policy authority.

OAuth remains an edge identity protocol. The local `tetherd` Policy Broker remains the final authority for machine actions.

## Reference persistence decision

The reference self-hosted deployment uses SQLite first.

Reasons:
- single-node self-hosting requires no additional database service;
- low operational and memory overhead;
- one durable file is simple to back up and restore;
- Node 22 already supplies the SQLite runtime, avoiding a native addon dependency;
- the oidc-provider adapter boundary remains storage-neutral so PostgreSQL can be added for multi-instance/hosted deployments.

SQLite is not a canonical Tetherplane capability or protocol concept.

## A3.1 — Persistent oidc-provider adapter

Add a narrow `auth` storage module implementing the pinned oidc-provider adapter contract.

Required behavior:
- file-backed SQLite only; production adapter must reject `:memory:`;
- model + id isolation;
- payload round-trip without schema-specific field loss;
- TTL enforcement;
- `findByUserCode`;
- `findByUid`;
- durable consume marker;
- destroy;
- grant revocation;
- indexes for lookup/revocation fields;
- WAL/busy-timeout safety for the single-node reference service;
- no token/payload logging.

The factory must return the oidc-provider AdapterConstructor plus an explicit close lifecycle so tests and service shutdown release the database cleanly.

## A3.2 — Production auth configuration and executable

Add a runnable `tether-auth` entry point that accepts deployment metadata and secret references without placing secrets on the command line or in Git.

Production startup must require:
- stable HTTPS issuer;
- canonical HTTPS MCP resource;
- persistent SQLite state path;
- explicit signing-key source;
- TLS or loopback-only reverse-proxy mode;
- device-login bridge configuration.

No implicit in-memory adapter fallback is allowed.

## A3.3 — Account bootstrap and claims

Complete the device-assisted account path needed for token issuance.

Requirements:
- paired-account proof remains the login authority;
- account lookup exposes only the stable subject needed by oidc-provider;
- no username/password database;
- no browser exposure of device credentials;
- consent remains restricted to the requested Tetherplane MCP resource/scope.

## A3.4 — Refresh, revocation, restart, and DCR/CIMD proof

Add integration tests proving:
- authorization state survives auth-service restart;
- refresh tokens survive restart until revoked/expired;
- revocation invalidates the relevant persisted grant/token state;
- DCR-created client state survives restart;
- ChatGPT-facing metadata and client registration behavior remain compatible;
- relay verification continues to enforce issuer, audience, signature, time, and scope.

## A3.5 — Deployment and operator surfaces

Add:
- reference auth container/deployment;
- health/readiness coverage;
- sensitive-volume guidance;
- backup/restore guidance;
- signing-key rotation procedure;
- bounded auth observability without tokens, cookies, codes, or client secrets;
- stable-domain/TLS deployment documentation;
- public plugin acceptance fixtures.

## TDD order

1. RED SQLite adapter contract tests.
2. GREEN minimum durable adapter.
3. Adapter restart/expiry/consume/revocation tests.
4. Full repository gate.
5. RED production CLI/config tests.
6. GREEN runnable service wiring.
7. RED account/token flow tests.
8. GREEN device-assisted account claims.
9. Refresh/revocation/DCR restart integration.
10. Deployment/container/docs.
11. Full Ubuntu + Windows gates.

## Exit proof

- no Auth0 dependency for the reference self-hosted authorization service;
- auth state survives process restart;
- no in-memory production adapter path;
- refresh/revocation behavior is persistent and tested;
- DCR/CIMD acceptance path is tested;
- no OAuth naming enters canonical kernel/provider semantics;
- relay remains compatible with external conforming OIDC providers;
- six default MCP tools remain unchanged;
- local `tetherd` remains final policy authority;
- full Ubuntu and Windows CI green.
