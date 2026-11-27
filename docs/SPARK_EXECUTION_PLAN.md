# Spark Execution Plan (for Muse Spark 1.3)

Architect is the decision-maker; Spark executes bounded assignments only. Common constraints for every assignment: preserve the six-tool surface (`device, files, process, browser, desktop, batch`); never broaden authority, replay ambiguous mutations, or touch live devices/production; work on the integration base below; return `{evidence, unresolved}` with test output — a green claim without output is a failed assignment.

**Integration base:** `origin/main` `9c93be6c`. All of #150/#153/#155–#159 are open drafts, none merged. Land #150 first, then the #152/#154 stacks in order, then #155, then #157–#159; #156 merges into its #155 base. Never merge a stacked PR directly to `main`. Escalate immediately on merge conflict or `BLOCKED`/review-required state — do not force around it.

## S1 — Agent heartbeat independence (fixes fault row 2, agent half)
Objective: heartbeat `select`ed independently of the ordered work queue (bounded 16/4 MiB/5s); Suspect ≤15s, dead ≤20s+delay. Files: `agent/tetherd/src/relay_ws.rs` only (+ its tests). Prohibited: relay changes, queue semantics change. Acceptance: silent-socket test detects without a browser probe; long-invoke test proves heartbeat still fires; healthy Pong causes no reconnect. Commands: `cargo test -p tetherd relay_ws`. Escalate if: detection cannot be bounded without dropping ordered delivery.

## S2 — Relay stale retirement (fault row 2, relay half)
Objective: nonce challenge after Pong, retire+terminate stale sockets ≤60s; superseded timers cannot retire the live socket. Files: `relay/src/devices/ws-gateway.ts` (+ tests). Acceptance: mismatched/missing Pong retires; current-generation socket unaffected. Commands: `pnpm --filter @tetherplane/relay test`. Escalate if: legacy agents on long work would be retired (report, do not loosen silently).

## S3 — Truthful capability health (fault row 9)
Objective: replace boolean `available` with per-capability `ready|degraded|disconnected|unauthorized|recovering` + freshness; re-probe browser at runtime; `/readyz` reflects freshness. Files: `agent/tetherd/src/runtime.rs`, `agent/providers/browser/src/lib.rs`, `relay/src/health-http.ts`, `agent/tether-core/src/error.rs`. Prohibited: new MCP tools. Acceptance: kill the bridge → capability reports `disconnected` while device stays online; degraded sub-service reports `degraded`. Commands: `cargo test --workspace`; `pnpm -r test`. Escalate if: a provider cannot be probed without side effects.

## S4 — Policy Desired/Effective/Acknowledged + `list_tabs`→`pages`
Objective: versioned desired state, dedicated ack channel, monotonic apply; adapter maps `list_tabs` to `pages`. Files: `agent/tether-core/src/principal.rs`, `agent/tetherd/src/relay_ws.rs`, `relay/src/routing/device-router.ts`, `adapters/compact-mcp/src/translate.ts`. Prohibited: any auth bypass; relay granting authority. Acceptance: out-of-order/delayed ack cannot regress Effective; relay shows `pending` until acked; denied call never reaches provider. Commands: `cargo test -p tether-core principal_policy`; `pnpm -r test`. Escalate on: any requirement to trust relay-supplied principal (refuse, report).

## S5 — Mandatory mutation keys + handle TTL (fault rows 3/7)
Objective: state-changing calls without a key are rejected (or auto-keyed with explicit `unkeyed` evidence flag — architect decides on escalation); handles expire. Files: `agent/tetherd/src/runtime.rs`, `agent/tetherd/src/idempotency.rs`, `agent/tether-core/src/handles.rs`. Acceptance: unkeyed retry cannot duplicate (mutation counter = 1); stale handle fails, no leak. Commands: `cargo test -p tetherd`. Escalate if: an existing client depends on unkeyed mutation (name it; do not silently keep the hole).

## S6 — Fault-lab execution
Objective: run `tests/fault-lab/` rows 1–9, 11, 12 with N≥20 seeds; publish timings. Files: `tests/fault-lab/` only. Acceptance: rows 2/9 pass after S1–S3 (fail before — attach the failing log as the baseline). Commands: `npm run fault-lab`. Escalate if: a row passes vacuously (fault never reached the code path) — that is a lab bug, fix the lab.

## S7 — Evidence emission (VouchOut-ready, no integration)
Objective: emit `ExecutionEvidence` per [SECURITY_INVARIANTS.md](/workspaces/Tetherplane/docs/SECURITY_INVARIANTS.md) from `AgentRuntime` post-policy. Files: `agent/tetherd/src/audit.rs`, `agent/tetherd/src/runtime.rs`. Acceptance: evidence contains hashes only (test asserts no raw args/keys); old-generation evidence marked superseded. Commands: `cargo test -p tetherd`. Escalate if: a field would require persisting secrets.

## S8 — Windows stages (owner/operator only, not Spark-autonomous)
Objective: add lock/sleep/reboot stages of [WINDOWS_ACCEPTANCE_PLAN.md](/workspaces/Tetherplane/docs/WINDOWS_ACCEPTANCE_PLAN.md) to the acceptance plan. Files: `scripts/live-acceptance-plan.json`, `docs/live-acceptance.md`. Acceptance: stages exist with observed-outcome fields; execution requires the operator on Windows — Spark must report `unverified` from any Linux host. Escalate: never self-certify.

## Escalation contract

Stop and escalate to the architect/owner when: an acceptance test contradicts a security invariant; a fix needs a new MCP tool, a grant widening, or replay of an ambiguous mutation; stacked-PR state conflicts; Windows behavior is asserted without Windows evidence; relay metrics are required but unmeasured. The owner is never responsible for spotting an architectural limitation — the assignment's escalation condition is.

## Closure-gate addendum (architect, post-inspection)

Dependency order is normative: **S1 → S2 → S6**; S3 parallel-safe with S1/S2 but serialized against S4 on `runtime.rs`; S4 after S1 (shared `relay_ws.rs`); S5 independent after S1; S7 after S3 preferred; S8 owner-only. First assignment is **S1 only** — do not start S2–S8 in the same change. Full evidence: [ARCHITECTURE_CLOSURE_GATE.md](/workspaces/Tetherplane/docs/ARCHITECTURE_CLOSURE_GATE.md).
