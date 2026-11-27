# Root Cause Register

Base: `main` `9c93be6c`. Verdicts were adversarially checked: each entry names the test that would break the current claim.

## RC-1 Half-open relay connection (Failure A) — confirmed

- Cause: `agent/tetherd/src/relay_ws.rs` `serve`/`connect_and_run` sends no client Ping and has no read timeout; `while socket.next().await` waits forever on a silent socket after relay restart.
- PR #156 (`RelayHeartbeat`, 10s interval, 5s send timeout, echo-required Pong) bounds *agent* detection to ~20s, but its `run_connected` loop still executes work inline, so one long invoke blocks the heartbeat. Relay side has no challenge/retire.
- Verdict: **PR #156 alone is falsified as a whole-class fix.** Required complements: heartbeat independent of ordered work with bounded queue; relay-side nonce challenge + retire; browser/CDP no-replay on new generation.
- Residual: a mutation already dispatched may complete with a lost result. Correct behavior is reconcile/`action_outcome_unknown`, never blind retry.

## RC-2 Principal divergence (Failure B) — confirmed

- Reported error: `permission_denied: principal human:owner … browser.list_tabs`.
- Causes, stacked: (1) `list_tabs` is not an operation — real op is `pages` (`browser/bridge/src/rpc-server.ts`); the compact adapter maps the name verbatim. (2) `DeviceRouter.call` overwrites principal to `human:owner` for routing, then `AgentRuntime.execute` overwrites again with the launch-bound local id, so `human:owner` is never effective unless the on-device profile *is* `human:owner`. (3) `PrincipalProfile` loads once at startup with no version/epoch; the relay protocol carries only `invoke`/`result` — no policy push/ack; the dashboard has no policy store to sync.
- Proof: e2e audit records the bound local id (`service:remote-device`), not the relay principal.
- Rule: **no bypass.** Fix is the Desired/Effective/Acknowledged model in [RECOVERY_PROTOCOL.md](/workspaces/Tetherplane/docs/RECOVERY_PROTOCOL.md), plus mapping `list_tabs` → `pages` at the adapter boundary.

## RC-3 False readiness (Failure C) — confirmed

- Cause: capability `available` is a startup snapshot (`browser_operations.is_some()`), frozen by one `connect_with_retry` handshake; bridge `status` hardcodes `available:true`; relay `isOnline` is WebSocket presence; `/readyz` returns a static `ready`; no `degraded`/`recovering` state exists anywhere.
- Result: device shows online + available while every browser/desktop call fails. Process liveness, registration, and auth success must never be presented as readiness.

## RC-4 Conditional exactly-once (Failure D, partial) — conditional

- With an idempotency key on a listed mutation capability, exactly-once holds (durable Replay/Conflict; e2e append-once after reconnect). Without a key, retries can duplicate. Crash-after-reserve leaves `Pending` forever → `ActionUnverified`. `HandleRegistry` has no TTL, so stale process/search handles leak.
- Rule: mutations require keys; ambiguous outcomes stay explicitly unknown.

## RC-5 Windows interactive dependency (Failure E) — unproven

- `windows_uia.rs` has no lock/secure-desktop branch; UIA worker death is permanent until agent restart; foreground leases are in-memory wall-clock (≤120s) and expire during sleep; install starts at logon only (offline before logon / after logoff). No live Windows evidence exists. See [WINDOWS_ACCEPTANCE_PLAN.md](/workspaces/Tetherplane/docs/WINDOWS_ACCEPTANCE_PLAN.md).

## RC-6 Single-relay and measurement gap (Failure F) — confirmed

- Relay sessions/pending/connections are in-memory and lost on restart (registry file survives; devices reconnect). Relay RSS/RTT unmeasured; cold-start target already missed with high variance. Resource claims survive only as a local `tetherd` floor.

## Onboarding corollary

Default Windows install ships no browser bridge/extension/Chromium check, so a "successful" install yields browser unavailable. Install, pairing, auth, browser integration, and readiness must each be independently verifiable (see quality gates).
