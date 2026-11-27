# Architecture Closure Gate — Architecture B

Status: **closed for S1 delegation**. Base: `main`/`origin/main` `9c93be6c`. Branch: `research/meta-reliability-architecture`. This gate authorizes only the first bounded Spark assignment (S1, below). It does not authorize implementing the roadmap, pushing, or merging.

## Gate 1 — `browser.list_tabs` trace (public MCP → adapter → protocol → relay → provider)

Call path for MCP tool `browser` with `op: "list_tabs"`:

| Hop | Code | Behavior for `list_tabs` |
|---|---|---|
| Public MCP | `adapters/compact-mcp/src/compact-tools.ts` (`commonInputSchema.op: z.string()`, six tools) | `op` is an unvalidated free string; forwarded verbatim. |
| Adapter | `adapters/compact-mcp/src/translate.ts` `canonicalCapability()` | Only `device job_*/audit_*` and `files search*` are special-cased; default is `` `${tool}.${operation}` `` → capability `browser.list_tabs`. **No alias table exists.** |
| Canonical protocol | `protocol/schemas/invocation.schema.json`, `agent/tether-core/src/envelope.rs` | `capability` is a free string (`minLength: 3`), `protocol_version` is `const "1.0"`. Unknown operations pass validation by design. |
| Relay authorization | `relay/src/mcp/http-gateway.ts`, `relay/src/routing/device-router.ts` `call()` | Authenticates the client, then **overwrites** `principal_id := identity.principalId` (e.g. `human:owner`), `device_id`, `actor`. Checks account/device/revocation only; no capability allowlist at the relay (routes only, by design). |
| Agent entry | `agent/tetherd/src/relay_ws.rs`, `agent/tetherd/src/runtime.rs` `execute()` | Checks `device_id`, then **overwrites again**: `invocation.principal_id := bound_principal_id` (launch-bound). The relay principal is never effective. |
| Policy | `agent/tether-core/src/policy.rs` `principal_denial_reason()` | `browser.list_tabs` ∉ profile `allowed_capabilities` → `Deny` → `permission_denied`, **before any provider dispatch**. |
| Provider (unreached here) | `browser/bridge/src/rpc-server.ts` `OPERATIONS`, `agent/providers/browser/src/lib.rs` | Canonical operations are `status, pages, create_tab, snapshot, navigate, close, act, wait, upload, downloads, diagnostics, checkpoint`. There is no `list_tabs`; had policy allowed it, the bridge would return `capability_unavailable`. |

**Verdict: naming translation is the primary cause; permission enforcement is the correct fail-closed surface; version drift is excluded.**

- Naming: the model-facing name `list_tabs` was never mapped to the canonical `browser.pages` at the adapter boundary (the one place aliases belong). Fix belongs to S4 (`list_tabs` → `pages` in `translate.ts`), not to the provider and not to policy.
- Permission: with a principal profile bound, the denial names the **effective local** principal and capability (`principal {} is not authorized for capability {}`); the e2e fixture (`tests/e2e/remote-plane.test.ts`, bound `service:remote-device`, audit-asserted) proves the relay's `human:owner` is overwritten and never effective. The denial is the system working as designed against a non-existent capability.
- Version drift excluded: every layer pins `protocol_version "1.0"` (adapter literal in `translate.ts`, `const` in both schemas, relay `errorResult` literal, agent echoes the invocation value). No version negotiation exists that could drift.
- Note the dual surface: with **no** principal profile bound, the same bad name would pass policy classification (`LocalReversible` → `Allow`) and fail later as `capability_unavailable` at the bridge. Same root cause, two error codes — diagnosis must check which profile is bound before interpreting the code.

## Gate 2 — Local principal security boundary (no authority expansion by synchronization)

Five distinct principals/state holders; conflating any two is a defect:

| Concept | Holder today | Meaning |
|---|---|---|
| Authenticated remote identity | Relay: OIDC/static auth → `ClientIdentity {accountId, clientId, principalId}` (`relay/src/auth/*`, bound once per MCP session in `http-gateway.ts`, mismatch → 403) | Who the remote caller authenticated as. Provenance only on the device. |
| Launch-bound local authority | Device: `PrincipalProfile` file via `tetherd --principal-profile` (`agent/tetherd/src/main.rs` `load_principal_profile`), enforced by `LocalPolicyBroker` | The hard ceiling and final decision-maker. Loaded once; changed only by local relaunch. |
| Desired permissions | **Does not exist yet** (no dashboard/relay policy store; relay protocol carries only `invoke`/`result` — `relay_ws.rs` `RelayInbound`/`RelayOutbound`) | Owner's versioned intent. S4 target. |
| Effective permissions | Device: the profile actually loaded and enforced | What calls are actually allowed right now. |
| Acknowledged permissions | **Does not exist yet** (no policy channel, no ack message) | Device-signed confirmation of the applied Desired version. S4 target. |

**No-widening proof obligation (for S4, checked at review):** (1) Effective after any sync ⊆ launch-bound ceiling — synchronization may narrow or restore within the ceiling, never exceed it; exceeding requires a local relaunch with a new profile. (2) Apply is monotonic (`version > current` only); stale/delayed acks cannot regress Effective. (3) Local denial always wins over Desired. (4) Relay never grants: it stores/forwards Desired and displays `pending` until Acknowledged == Desired; unacked state is never advertised as effective. (5) Every denied call fails before provider dispatch (existing `principal_policy` test property). Until S4 ships, effective changes require editing the on-device profile, restarting `tetherd`, and verifying via `device.capabilities` plus a real `browser` `pages` call.

## Gate 3 — Idempotency refined: uncertain outcome, not unconditional exactly-once

Current store (`agent/tetherd/src/idempotency.rs`, `runtime.rs` `execute_idempotent`): `reserve` (create-new Pending file) → `router.execute` → `complete` (temp-write + rename to Completed, delete Pending). Lookup order: Completed → Replay/Conflict; Pending → `pending_result`; else Miss.

Crash-window analysis:

| Crash point | Durable state after restart | Required behavior |
|---|---|---|
| Before `reserve` | Nothing | Safe to execute on retry (same key). |
| After `reserve`, before/during execute | Pending only | **Uncertain.** Side effect may or may not have happened. Return `action_unverified`; never auto-retry. |
| **After side effect, before `complete` is durable** | Pending only (result lost) | **Uncertain — the critical window.** The mutation happened but no result is recorded. Return `action_unverified`; owner-visible reconcile only. This is why unconditional exactly-once is **not** promised. |
| After Completed rename, before Pending delete | Completed wins (lookup checks Completed first) | Replay stored result with new `request_id`. Safe. |
| No idempotency key at all | Nothing (`execute_idempotent` is bypassed) | **No guarantee.** Retry may duplicate. S5 must reject or explicitly flag unkeyed mutations. |

Guarantee as refined (replaces any "exactly-once" wording): **at-most-once execution per (principal, device, capability, key, fingerprint); exactly-once visible effect only once a Completed record is durable; the reserve→complete window yields an explicit uncertain-outcome state.** The wire name for that state is the existing error code `action_unverified` (`protocol/schemas/error.schema.json`); prose `action_outcome_unknown` in [RECOVERY_PROTOCOL.md](/workspaces/Tetherplane/docs/RECOVERY_PROTOCOL.md) and [CONNECTION_STATE_MACHINE.md](/workspaces/Tetherplane/docs/CONNECTION_STATE_MACHINE.md) means the same state and must not be implemented as a second code. Known limits to close in S5: Pending records have no TTL/reconcile path (they block the key forever by design until owner action), and `complete`/`reserve` write+rename without `fsync` of file and directory — durability is therefore guaranteed against process crash, not yet against OS/power loss.

## Gate 4 — Heartbeat independence and generation retirement

Current state (falsifies any "already handled" claim): `agent/tetherd/src/relay_ws.rs` `connect_and_run` is a single sequential loop — `socket.next().await`, then `runtime.execute().await` inline, then send. It sends no client Ping and has no read timeout, so (a) a silent/blackholed socket hangs forever, and (b) one long invoke blocks even the Ping→Pong reply. The relay (`relay/src/devices/ws-gateway.ts`) likewise has no heartbeat or stale timer; it retires sockets only on close/error, supersede (4000), or revoke (4001). Generation fencing for **results** already exists and is proven (`DeviceRouter` generation UUID, `#receive`/`#isCurrent` checks, router oracle in fault-lab row 1/6/8).

Required design (normative in [CONNECTION_STATE_MACHINE.md](/workspaces/Tetherplane/docs/CONNECTION_STATE_MACHINE.md), implemented by S1+S2): the agent splits the socket; a dedicated heartbeat task is `select`ed against a bounded work queue (16 / 4 MiB / 5 s wait) so liveness never waits on ordered execution; one missed/unechoed Pong → Suspect ≤15 s, deadline expiry → close + reconnect with backoff, new socket = new generation. The relay challenges with a nonce after Pong and retires+terminates stale sockets ≤60 s; retirement is generation-guarded (a superseded socket's timers/handlers can never retire the live socket — the close-handler socket-identity check in `ws-gateway.ts` is the existing pattern to extend). On retirement both sides settle in-flight work as `disconnected`, drop per-generation queues, and never send an old-generation result on a new socket; fatal auth (401/403) is terminal with no retry loop.

## Gate 5 — Dependency installation blocker (resolved, pinned, isolated)

Blocker observed: workspace `node_modules` contained only `typescript`; `pnpm install` failed with `EROFS` creating `/home/codespace/.local/share/pnpm/global`, and the fault lab reported row 5 `blocked-env` (`ERR_MODULE_NOT_FOUND: ws`). Root cause was unwritable user-level cache/store directories in this sandbox, not missing packages or network policy.

Resolution (no lockfile mutation, no new dependencies): redirect only cache/store locations to the writable temp root and install from the committed lockfile — `PNPM_HOME=/tmp/pnpm-home pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store --ignore-scripts` with `packageManager: pnpm@10.34.5` and `pnpm-lock.yaml` (lockfileVersion 9.0, exact pinned specifiers, e.g. `ws 8.21.3`, `@modelcontextprotocol/sdk 1.30.0`). Verified: `pnpm-lock.yaml` byte-unchanged after install; relay routing + device-ws oracles pass (6/6); fault lab rows 1/5 pass, rows 2/9 remain honestly `known-fail-on-main`. Registry access was needed only for the lockfile-pinned tarballs from `registry.npmjs.org` via the existing proxy — that is the narrow scope to request wherever the sandbox blocks it; never resolve or add unpinned versions. The stray untracked root `package-lock.json` (npm artifact) is **not** committed: this repo is pnpm-controlled and a second lockfile would fork dependency truth. Rust note: no `cargo`/`rustc` exists in this sandbox, so Rust test commands below must run in Spark's environment (stable toolchain per `rust-toolchain.toml`); absence of the toolchain is an escalation, not a reason to skip tests. Fault experiments stay isolated: `tests/fault-lab/` runs only the repo's temp-dir oracles; no live device, production relay, or real user state; Linux results never certify Windows behavior.

## Gate 6 — Preservation

The nine deliverables ([RELIABILITY_ARCHITECTURE.md](/workspaces/Tetherplane/docs/RELIABILITY_ARCHITECTURE.md), [ROOT_CAUSE_REGISTER.md](/workspaces/Tetherplane/docs/ROOT_CAUSE_REGISTER.md), [CONNECTION_STATE_MACHINE.md](/workspaces/Tetherplane/docs/CONNECTION_STATE_MACHINE.md), [RECOVERY_PROTOCOL.md](/workspaces/Tetherplane/docs/RECOVERY_PROTOCOL.md), [SECURITY_INVARIANTS.md](/workspaces/Tetherplane/docs/SECURITY_INVARIANTS.md), [FAULT_INJECTION_MATRIX.md](/workspaces/Tetherplane/docs/FAULT_INJECTION_MATRIX.md), [SPARK_EXECUTION_PLAN.md](/workspaces/Tetherplane/docs/SPARK_EXECUTION_PLAN.md), [RELEASE_QUALITY_GATES.md](/workspaces/Tetherplane/docs/RELEASE_QUALITY_GATES.md), [WINDOWS_ACCEPTANCE_PLAN.md](/workspaces/Tetherplane/docs/WINDOWS_ACCEPTANCE_PLAN.md)), this closure record, and `tests/fault-lab/` are committed locally on `research/meta-reliability-architecture`. **No push, no merge.**

## Gate 7 — S1–S8 dependency order and first assignment

| Step | Depends on | File-overlap / ordering reason |
|---|---|---|
| S1 agent heartbeat independence | — | Touches `relay_ws.rs` alone; unblocks the relay half. **First.** |
| S2 relay stale retirement | S1 | Relay nonce challenge needs the agent's independent Pong/echo to avoid retiring healthy long-running agents. |
| S3 truthful capability health | — (parallel-safe with S1/S2) | Different files (`runtime.rs`, browser provider, `health-http.ts`); do not interleave with S4's `runtime.rs` changes. |
| S4 policy Desired/Effective/Acknowledged + `list_tabs`→`pages` | S1 | Shares `relay_ws.rs` (dedicated policy channel) with S1; sequence after S1 to avoid stacked conflicts. |
| S5 mandatory mutation keys + handle TTL | — | Independent (`idempotency.rs`, `handles.rs`); any time after S1. |
| S6 fault-lab execution (N≥20) | S1, S2, S3 | Rows 2/9 can only pass after their fixes land. |
| S7 evidence emission | — | Independent; after S3 preferred so evidence carries truthful capability state. |
| S8 Windows stages | Owner/operator only | Never Spark-autonomous; Linux can only report `unverified`. |

**Selected first assignment: S1.** It is single-file, changes no production infrastructure (agent code + tests only; no relay, deploy, or protocol change), and produces a measurable improvement: fault-matrix row 2's agent half goes from "hangs forever" to a bounded detect (Suspect ≤15 s, dead ≤20 s + reconnect delay), proven by a silent-socket test and a long-invoke test. The exact Spark prompt follows in [SPARK_EXECUTION_PLAN.md](/workspaces/Tetherplane/docs/SPARK_EXECUTION_PLAN.md) (S1 section) and is reproduced verbatim in the architect's handoff message.
