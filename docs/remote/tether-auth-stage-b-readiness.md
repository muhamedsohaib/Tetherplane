# Tether-auth issuer cutover: readiness and rollback gate

**Status:** preparation checklist only. This file does **not** authorize a live issuer change.
**Scope:** preserve verified source, prove the intended device/account mapping, and validate an Auth0 rollback before requesting separate Stage B approval.

Read with [ChatGPT OAuth](chatgpt-oauth.md), [self-hosted auth](self-host-auth.md), and the [browser migration plan](../superpowers/plans/2026-10-14-tether-auth-browser-migration.md). The canonical design and implementation roadmap remain authoritative.

## Non-negotiable invariants

- The active relay continues to verify Auth0 tokens until a separately approved Stage B operation.
- The canonical MCP resource/audience, six tools (`device`, `files`, `process`, `browser`, `desktop`, `batch`), device registry, device credentials, existing bindings, and local Policy Broker are unchanged.
- Never put access tokens, private signing keys, callback codes, bridge credentials, cookies, device credentials, full sensitive config files, or SQLite row payloads into Git, chat, shell output, tests, or logs.
- All remote inspection is authorized, read-only, and targets only the designated execution and relay machines. Do not modify other devices.
- Tether-auth's successful device approval proves the account associated with that approving device. It does **not** prove another device is paired to the same account.
- A documentation or automated-test pass is not a substitute for live ChatGPT tool discovery, authorized device RPC, and Policy Broker denial after the switch.

## Gate 1 — Preserve tested changes in Git before touching the live issuer

1. On the canonical development computer, capture `git status --short`, `git branch --show-current`, `git log --oneline --decorate -5`, and `git remote -v`. Record the exact tested and deployed source SHA; do not assume a local branch equals the deployed build.
2. Preserve every staged, unstaged, and untracked file. In particular, do not `reset`, `clean`, switch the dirty worktree, overwrite the index, or blindly `stash` files. Do not commit unrelated staged files under a misleading auth message.
3. Fetch the existing browser-login feature branch and PR. Compare its changes against the current uncommitted authentication, CSP, proxy, bridge-timeout, DCR throttling, consent, and regression-test work.
4. Use a **separate worktree** rooted at a reviewed feature-branch commit to integrate only relevant source/tests/documentation. Copy only explicitly inventoried project files; leave unrelated archives and existing staged changes untouched. Review conflicts instead of overwriting.
5. Make focused commits for independent, tested fixes. Keep PR history additive; do not force-push or rewrite published history. Push verified commits to the corresponding GitHub feature branch and reconcile the existing draft PR rather than opening a duplicate auth PR.
6. Run fresh verification **on the exact tree being committed**: TypeScript test/typecheck/build, targeted integration/browser tests, formatting, Rust gates, and public-hygiene checks. Obtain CI proof on the pushed SHA. Record known environment-specific failures, such as Windows Application Control policy blocking a test binary, as **not passing**, rather than silently excluding them.
7. Verify release/build provenance on the relay machine: the running auth build must match the reviewed and tested source. If it does not, stop and reconcile provenance; do not proceed with an issuer cutover against uncommitted-only behavior.

**Evidence to retain:** feature branch, source SHA, tested CI URL/status, list of touched paths, clean isolated worktree, preserved original dirty-worktree inventory, deployed build SHA/hash. No credential values.

## Gate 2 — Prove the intended Leno/account/policy mapping

1. Read the existing relay registry with a privileged **read-only** operation, or query the authenticated management API using an existing authorized identity. Do not print `credentialHash` or unrelated device records.
2. Verify a non-revoked **Leno** binding exists and identify its owning account internally. Verify VAULTER's device approval maps to that **same** existing account. Return only `same_account=true/false` and device online/paired flags, not raw account identifiers.
3. Verify the previously issued tether-auth JWT `sub` represents that same account; ensure the proposed relay subject strategy would map `sub` to `accountId`, with the intended nonprivileged principal provenance. Independently verify issuer, audience, scope, subject, and client claim validation remains strict.
4. Verify Leno is actually connected to the existing relay (not merely reachable by Tailscale). If it is offline, record the blocker. Do not silently pair again, invent a new account, change the registry, or widen path/foreground permissions.
5. Before cutover, authenticated checks may use the **currently trusted Auth0** mechanism. A tether-auth token **must fail** against the Auth0-configured relay until Stage B is separately approved; that failure is expected, not a reason to change the verifier prematurely.
6. Inspect the Leno agent's launch-bound local policy in sanitized form. Document the allowed-root and denial test target without expanding authority or accessing out-of-scope content. Do not run a destructive test.
7. Record exactly what can be proven without switching issuer. Live authenticated Leno status **with a tether-auth token** is necessarily a post-cutover acceptance gate, not a pre-cutover proof.

**Stop conditions:** missing/revoked Leno pairing, unequal account mapping, unknown subject mapping, unavailable local policy, or device RPC not recoverable under the existing provider.

## Gate 3 — Prepare a verifiable Auth0 rollback

1. On the relay host, inspect the actual process owner, executable, active command, secure environment-variable **names**, port bindings, and service/scheduled-task launch mechanism. Do not assume a Windows task marked `Ready` is the running relay process.
2. Capture the existing Auth0 relay authorization configuration, device registry, task/service definition, current relay build identity, and current Serve/Funnel routing **into a restricted operator-only backup directory** outside Git. Use file hashes and restrictive ACLs; never print secrets or sensitive JSON. The existing `/mcp` and device transport mappings must be preserved.
3. For tether-auth SQLite state, use a SQLite-aware online backup or coordinated clean-stop procedure; never copy only the main SQLite file while WAL writes may be active. Back up signing keys separately in a secure location and verify the backup can be read by the designated service identity.
4. Record public **nonsecret** baseline observations: relay and authorization health/readiness, exact OAuth protected-resource issuer (Auth0), unchanged canonical MCP resource, six tool descriptors, and current device connection state.
5. Prepare a written rollback command sequence **adapted to the observed service runner**: restore the exact Auth0 config atomically, restart only the relay through its verified owner, allow outbound device reconnections, and rerun the baseline probes. Keep tether-auth staged; do not delete its SQLite/JWKS state. Do not improvise `schtasks /run` if it would start a second relay instance.
6. Rehearse rollback **without touching the live verifier**: validate the saved file/hash, parse the saved auth configuration in an isolated process, verify expected environment variable names exist without printing values, and exercise file restoration against a disposable directory or separate loopback test instance. Record a successful restoration verification and an abort/rollback operator.
7. Before Stage B, establish concrete failure triggers: new issuer metadata wrong; relay fails readiness; existing paired device disconnects and does not reconnect; token validation breaks; tool discovery differs from exactly six; authenticated Leno status fails; policy denial fails; or ChatGPT linking fails. A trigger must initiate prompt rollback using the captured plan.

**Rollback completion proof:** public resource metadata once again advertises Auth0, existing Auth0 authentication and six tools work, Leno/VAULTER paired device state is intact, and a permitted read-only device check succeeds. Never claim rollback succeeded from a process restart alone.

## Stage B approval boundary and post-cutover acceptance

- **Not authorized by this document:** switching the active relay issuer/JWKS verifier, disabling Auth0, removing Auth0 bindings, changing the canonical MCP resource, changing existing device pairings or local policy, or retiring rollback material.
- Before seeking Stage B approval, report the full three-gate evidence matrix and unresolved failures. Explicitly disclose unsupported DCR client deletion, non-edge DCR rate limiting, environment-specific workspace test failures, and remaining human-facing device-approval UX limitations.
- **Only after separate approval**, switch the relay verifier with the smallest reviewed change and immediately check real ChatGPT OAuth linking, exactly six tool descriptors, authenticated `device` status for Leno, denied outside-root capability, invalid signature/issuer/audience/scope/client rejection, and current device reconnection behavior.
- Do not widen policy as a remedy for an OAuth, routing, or pairing failure. On any stop condition, use the prepared Auth0 rollback and capture fresh observed evidence.

## Execution record (fill from real verification, never assumptions)

| Gate | Required recorded evidence | Status |
| --- | --- | --- |
| Git provenance | Commit SHA, CI run, deployed build match, preserved dirty-index inventory | Pending |
| Leno pairing | Binding exists, device online, VAULTER ownership matches, token subject matches, policy roots unchanged | Pending |
| Rollback | Restricted snapshot hashes, verified runner, offline restoration rehearsal, baseline probes | Pending |
| Stage B approval | Explicit user approval after Gates 1–3 | Not granted |

Do not replace any `Pending` item with `Passed` without fresh commands and observed results from the actual machines.
