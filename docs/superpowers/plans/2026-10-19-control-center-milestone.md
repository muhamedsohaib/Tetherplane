# Tetherplane Control Center Implementation Plan

> Use superpowers:executing-plans and test-driven-development. The user explicitly
> requested implementation; proceed through reversible work and independent review.

**Goal:** Deliver a working local portal over existing authenticated relay APIs.

**Architecture:** A loopback-only Node.js backend holds an existing relay bearer
in memory behind an opaque browser session. A static UI consumes a minimal local
API without changing relay, agent, OAuth, MCP or the installed topology.

**Tech Stack:** Existing Node.js 22+/TypeScript/pnpm, node:test; static HTML/CSS/JS.

**Spec:** `docs/superpowers/specs/2026-10-19-control-center-milestone-design.md`

## Global constraints

- Fixed relay origin; HTTPS or numeric loopback HTTP only; localhost portal only.
- Existing authentication and account binding remain authoritative on each action.
- Sessions last at most 15 minutes; bearer credentials remain in server memory.
- Connectivity and version are "Not reported"; never synthesize device records.
- Use supplied local media; reduced motion; no third-party assets or new runtime dependencies.
- No production access, merge, deployment, release, client registration or spending.

## Review focus

- Concurrent logout/auth changes must not restore a cleared browser view.
- Host/Origin tricks and encoded paths must not turn the service into a proxy.
- Stale/cross-account device IDs must never authorize revocation.
- Relay errors/redirects must not leak credentials or display stale status as fresh.
- Slow, oversized or malformed bodies must fail within bounds and remain recoverable.

## Task 1: Local session and relay contract

Files: `adapters/control-center/{package.json,tsconfig*.json}`, `src/{server,relay-client,cli}.ts`,
`test/{server,relay-client,cli}.test.ts`.

Interfaces: `ControlCenterServer({relayUrl, sessionTtlMs?, now?})`,
`listen({port?}): Promise<string>`, `close(): Promise<void>`;
local `POST /api/session {token}`, `GET /api/session`, `GET /api/devices`,
`POST /api/logout`, `POST /api/devices/:id/revoke {confirmDeviceId}`.
Session/device responses contain `csrfToken`, `expiresAt`, `devices`, `observedAt`;
device records project only `deviceId`, `pairedAt`, `revokedAt` plus
`connectivity: "not_reported"`, `version: null`. Errors use `{error:{code,message}}`.

- [ ] Write real HTTP/RelayServer integration tests for auth, account isolation,
  confirmation, revocation, expiry/logout, anti-CSRF and Host/Origin checks.
- [ ] Observe RED, implement the minimal bounded server/client, then observe GREEN.
- [ ] Add adversarial upstream/CLI tests before the relevant hardening code.
- [ ] Verify typecheck/build and targeted suites; commit the working backend.

## Task 2: Usable portal and supplied branding

Files: `adapters/control-center/public/{index.html,app.js,style.css,assets/*}`,
browser behavior tests, build asset-copy script, README.
Consumes Task 1 local API; credentials cleared after submit; CSRF lives in memory.

- [ ] Write behavior tests for login/empty/list/error/revoke/logout/loading/races.
- [ ] Observe RED, implement semantic responsive UI with safe text rendering.
- [ ] Import only inspected asset files and record SHA-256 provenance.
- [ ] Run behavior/security suites, typecheck/build; commit the usable portal.

## Task 3: Repository integration and evidence

Files: root README, portal README, `.github/workflows/ci.yml` if necessary,
verification report under `docs/verification/`.

- [ ] Verify fresh package integration in recursive workspace commands.
- [ ] Run applicable local gates; avoid desktop fixtures on the human's machine.
- [ ] Independently review the whole diff and fix consequential findings with TDD.
- [ ] Push only the dedicated verified feature branch; run full Windows/Ubuntu CI.
- [ ] Record exact-head results, baseline failures if any, and remaining live gates.
