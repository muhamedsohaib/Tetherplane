# Tetherplane Production Readiness Plan

**Date:** 2026-09-25  
**Branch:** `feature/production-relay-m1`  
**Base:** `feature/chatgpt-oauth-edge` at `a35f530`

## Goal

Move Tetherplane from a verified engineering/release candidate into a production-grade, publicly deployable control plane that can serve ChatGPT plugins, generic MCP clients, and local/OpenAI-compatible model clients without changing canonical capability semantics.

## Non-negotiable architecture

- The local Tetherplane agent remains the final execution and policy authority.
- Default AI-visible MCP surface remains exactly six tools: `device`, `files`, `process`, `browser`, `desktop`, `batch`.
- `background_only` remains the default coexistence mode.
- Human-owned resources remain protected.
- Cloud relay and AI clients can only narrow authority; they cannot widen local policy.
- Local mode remains fully usable without the hosted relay.
- Model-neutral execution remains first-class; ChatGPT is one client, not the kernel boundary.
- Secrets must not appear in Git, logs, command output, fixtures, container images, or documentation examples.

## Production gates

### Gate 1 — Core conformance
Preserve the existing protocol, principal authorization, idempotency, job/checkpoint/audit, provider boundaries, six-tool Compact MCP contract, and full repository gates.

### Gate 2 — Production device agent
Verify Windows service/supervisor lifecycle, crash recovery, state preservation, upgrade/uninstall behavior, secret storage, and clean-machine packaging.

### Gate 3 — Production relay and identity
Provide a reproducible deployment artifact, liveness/readiness endpoints, durable bounded pairing state, TLS/OIDC deployment guidance, safe shutdown, and stable public HTTPS deployment support.

### Gate 4 — Browser and desktop acceptance
Maintain authenticated-profile browser operation, ownership, verified actions, stale-reference recovery, native upload/download, UI Automation semantics, coexistence assertions, and foreground lease enforcement.

### Gate 5 — Client ecosystem
Keep three supported paths:
1. public ChatGPT plugin / Apps SDK MCP edge;
2. generic MCP clients;
3. local/OpenAI-compatible model client through a dedicated authenticated principal.

### Gate 6 — Security and reliability
Run threat-model, redaction, traversal, replay, routing-isolation, reconnect, browser-restart, sleep/wake, approval/lease, and coexistence tests. Add deployment-specific security checks.

### Gate 7 — Distribution and public release
Publish stable deployment docs, privacy/terms/support surfaces, signed/versioned release artifacts, public-plugin submission metadata, and a fresh operator-observed acceptance proof before tagging a production release.

## Milestone P1 — Production relay deployability

This branch starts with the first currently verified gap: the repository has no production relay container/deployment artifact even though OAuth deployment requires a stable public HTTPS relay.

### P1.1 Health contract — TDD
1. Add failing relay tests requiring unauthenticated `GET /healthz` and `GET /readyz`.
2. Require minimal responses that expose no device/account/session state.
3. Verify RED in CI.
4. Implement the smallest health gateway.
5. Verify targeted relay tests and full CI.

### P1.2 Reproducible relay container — TDD
1. Add failing contract tests requiring a root-level relay Dockerfile and secret-safe `.dockerignore`.
2. Require Node 22, a non-root runtime user, production environment, port 8788, and a direct relay CLI entrypoint.
3. Verify RED in CI.
4. Implement the smallest reproducible image from the monorepo.
5. Add an Ubuntu CI container-build gate.
6. Verify full CI.

### P1.3 Deployment documentation
Document:
- direct TLS termination in `tether-relay`;
- stable public hostname requirement;
- OIDC/auth config mounted at runtime;
- state volume mount;
- certificate/key mounts;
- health/readiness endpoints;
- no credentials baked into the image.

## Exit proof for P1

- Relay unit/HTTP suites green.
- Dockerfile contract tests green.
- Ubuntu image build green in CI.
- Windows and Ubuntu repository CI remain green.
- Six-tool MCP contract unchanged.
- OAuth discovery/auth behavior unchanged.
- No secret material or live credentials added.
- Branch is ready for review/merge only after fresh CI evidence.
