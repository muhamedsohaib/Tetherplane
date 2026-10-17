# Repeatable Windows onboarding — implementation plan (as built)

Base: `f81706f` (fix branch HEAD; deployed relay `c526e4a` differs only by a test).
Isolated worktree, strict TDD (Pester 3.4 + node:test), temp install/state/task
names and mocked scheduler. Nothing live was installed, paired, restarted, or
reconfigured.

## Approved architecture (supersedes the first draft)

The first draft kept owner approval as a manual authenticated management call
that needed an OAuth bearer. The controller review rejected that as unusable
and approved an additive operation under the existing `device` tool:

- `device(op="approve_pairing", args={userCode, expectedDeviceId}, response_mode="normal")`.
  Pairing values live in the **nested `args`** of the real installed tool schema
  (`op`, `args`, `device`, `response_mode`, ...). There are no invented top-level
  fields, and an `accountId`/`principalId` in either envelope level is ignored.
- It is **relay-only**. The relay gateway recognizes the outer `op`, binds the
  account exclusively from the validated OAuth session identity, and calls the
  existing registry pairing semantics. It never routes to a device, so no agent
  policy changes (the Rust policy and tests are untouched).
- Fail-closed, consuming nothing on any rejection: anonymous or invalid bearer,
  unknown session, session bound to another account, malformed or missing
  `args` (including `null`/array/string), wrong expected device, expired or
  reused code.
- Six top-level tools are unchanged. The `device` tool description now names
  `approve_pairing`, its arguments, and that it is not read-only, so ChatGPT can
  discover it without `device.help`; `device(op="schema")` serves its schema.
- **Not deployed to the live relay.** It awaits review and a guarded deployment.

## Authority and invariants

- One ChatGPT plugin connection per account/workspace is reused. No duplicate
  app, no per-computer OAuth client, no Auth0/Composio.
- Each controlled computer generates its own 32-byte credential locally; only its
  SHA-256 hash is sent (`POST /pair/start` on the existing HTTPS origin). The
  device WSS endpoint `wss://vaulter.tailf65eba.ts.net:10000/device` was read
  from the live Leno launcher and is tailnet-only (documented prerequisite).
- Local launch-bound policy stays the final authority. New installs get an
  explicit least-privilege principal (`device.status`, no roots,
  `authentication: local_process_binding`, UTF-8 without BOM); an existing
  principal is never rewritten.

## Deliverables

| Area | Files |
| --- | --- |
| Relay operation | `relay/src/mcp/http-gateway.ts`, `relay/src/routing/device-router.ts`, `relay/src/devices/registry.ts`, `relay/test/device-approve-pairing.test.ts` |
| Tool metadata | `adapters/compact-mcp/src/{compact-tools,schema-catalog}.ts`, `adapters/compact-mcp/test/device-{schema,description}.test.ts` |
| Profile | `docs/remote/connection-profile.json` |
| Setup / pair / doctor | `scripts/{setup-windows-device,pair-windows-device,doctor-tetherplane}.ps1` |
| Supervisor | `packaging/windows/tetherplane-agent.ps1` (single-instance mutex) |
| Kit | `scripts/package-windows-device-kit.ps1`, `scripts/verify-windows-device-kit.ps1` |
| Gates | `scripts/run-onboarding-tests.ps1`, `tests/onboarding/*.Tests.ps1` |
| CI | `.github/workflows/windows-onboarding-kit.yml` (independent; private artifact) |
| Docs | `docs/remote/onboarding-windows.md`, this plan, `docs/onboarding/HANDOFF.md` |

## Test matrix (all RED first)

1. Package: required hash manifest covering every required file, traversal
   rejection, tamper detection, architecture/source-commit evidence.
2. Install: managed-prefix repair that never deletes unknown files, refusal of
   an unmanaged prefix, no `-Force`.
3. Identity: SID-based ACLs set before the secret is written, failure discards
   the secret, ACL re-validated on reuse, no credential in output.
4. Pairing: only the hash is sent; an unexpired recorded code is resumed rather
   than rotated; expired and already-paired diagnostics.
5. Composed setup CLI against a loopback relay, including run from the
   unpacked kit with no `-Run`/`-PackagePath`.
6. Finalize: ownership-checked per-user task, explicit single-instance settings,
   started immediately, mocked scheduler only.
7. **Real artifacts**: the built `tetherd` loads the profile the generator wrote
   (`device.status` succeeds, `process.run` is `permission_denied`); the real
   supervisor passes the generated arguments intact (path with spaces) and a
   second supervisor does not start a duplicate agent (mutation-checked).
8. Doctor: honest `unverified` statuses, PID-correlated local transport,
   launch-bound policy source, tailnet reachability.
9. Runner exits nonzero from `FailedCount`, and for empty or inconclusive runs.

## Non-goals (unchanged)

No live installs/repairs/restarts, no issuer/config/Funnel/task changes, no
releases/tags, no policy/root expansion, no credential or config copying between
computers, no new top-level MCP tool, no deployed approval operation.
