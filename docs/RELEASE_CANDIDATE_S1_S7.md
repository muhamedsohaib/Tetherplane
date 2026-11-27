# Release Candidate: Architecture B S1–S7

Branch: `research/meta-reliability-architecture`. Code checkpoint: `35dc22a2`
(S7). This document plus [BLOCKER_REGISTER.md](/workspaces/Tetherplane/docs/BLOCKER_REGISTER.md)
is the consolidated handoff for owner review and S8 Gate 3 execution.

Linux evidence only. Nothing here certifies Windows behavior — see
[WINDOWS_ACCEPTANCE_PLAN.md](/workspaces/Tetherplane/docs/WINDOWS_ACCEPTANCE_PLAN.md)
and the S8 stages in `scripts/live-acceptance-plan.json` (all `unverified`).

## Checkpoint index (local commits, oldest first)

| Assignment | Commit | Content |
|---|---|---|
| S1 | `429a3925` | Agent heartbeat independent of ordered work queue |
| S2 | `3024b7c2` | Relay nonce heartbeat, stale-socket retirement, generation fencing |
| S2 amend | `77e3d07d` | Tolerate delayed/unsolicited Pongs without retiring |
| S6 | `fb911baa` | Fault-lab row-2 execution, real agent + relay, N=20 |
| S3 | `cde6547c` | Truthful per-capability readiness with freshness; row-9 20/20 |
| S4 | `f89a8629` | Desired/Effective/Acknowledged policy sync + `list_tabs`→`pages` alias |
| S4 closure | `ed8e7ae6` | Durable Desired, hold-while-pending, batch-leaf enforcement |
| S5 | `42bf1431` | Auto-keyed mutations with durable reserve + handle TTL |
| S7 | `35dc22a2` | Provider-neutral `ExecutionEvidence` emission post-policy |

Upgrade sequence (normative): S1 agents must be installed before S2 relay
enforcement is activated — see `tests/fault-lab/UPGRADE_SEQUENCE.md`.

## Behavior delivered

- **S1**: dedicated heartbeat task `select`ed against a bounded work queue
  (16 / 4 MiB / 5 s); liveness never waits on ordered execution.
- **S2**: relay challenges with a nonce after Pong; stale sockets retired +
  terminated ≤60 s; retirement is generation-guarded; in-flight work
  settles `disconnected`; nothing replays across generations.
- **S6**: row-2 half-open blackhole bounded detection measured on the real
  integrated pair; reconnect measured honestly only after connectivity
  returns (restore ≤30 s bound).
- **S3**: per-capability `ready|degraded|disconnected|unauthorized|`
  `recovering` + `observed_at` + reason; browser re-probed live;
  `/readyz` reflects freshness; device stays online when a provider fails.
- **S4**: versioned Desired → Effective (launch ceiling, narrows only) →
  Acknowledged over a dedicated channel; out-of-order/stale acks cannot
  regress; relay shows `pending` until acked; denied calls never reach
  providers; Desired persists across relay restarts; routing holds while
  sync is pending; batches are atomic under sync (depth ≤8, total ≤256).
- **S5**: every mutation executes under a key — explicit keys preserved,
  unkeyed requests get deterministic request-scoped `unkeyed-` keys
  (retry replays, new request executes, mutated payload conflicts);
  reserve/complete fsync file + directory before execution; uncertain
  outcomes stay `action_unverified`, never auto-replayed; handles carry
  a sliding 24 h TTL with insert-sweep eviction.
- **S7**: `AgentRuntime` emits hash-chained `ExecutionEvidence` alongside
  (never inside) `ResultEnvelope`: success / confirmed failure /
  uncertain / duplicate handling, launch-ceiling authorization state,
  durability availability, connection generation with supersession, and
  an attestation pinned to `observed-provider-response-only` with
  `proves_user_intent: false`. Hashes only; gaps explicit. No `VouchOut`
  dependency — integration needs separate owner approval.

## Gate 1 evidence (fresh, S7 tree)

Rust (`cargo test --workspace`): 34 suites `ok`, 0 failed. Includes
`tetherd` 90 (bin 62: relay_ws 28, evidence 11, runtime health/policy;
integration idempotency 8, evidence 2, audit 2, job/stdio),
`tether-core` handles 7/7 and `principal_policy` 11/11.
`cargo clippy --workspace --all-targets -- -D warnings`: clean.
`cargo fmt --check`, `cargo build --workspace`: clean.
`scripts/check-no-unsafe.py`: `UNSAFE_SCAN_OK`.

TypeScript (`pnpm -r typecheck`, `pnpm -r build`): clean monorepo-wide.
Tests: browser-lab 3/0, protocol 4/0, auth 17/0, model-client 20/0,
compact-mcp 14/14 (includes the exact-six-tools assertion), rdc-compat
8/0, extension 47/0, relay 101/0, e2e 25 pass / 3 skipped with 1
pre-existing Chromium-missing failure (B8), browser-bridge 60 pass with
3 pre-existing Chromium-missing failures. All 4 failures are the known
no-Chromium-on-Linux environmental gap, unchanged by S1–S7.

Bench (`scripts/bench-local.sh` @ `35dc22a2`): direct-agent cold start
11.2 ms, idle RSS 5.48 MiB after 10 s.

Fault lab: rows 2 and 9 carry N=20 `pass` from `fb911baa`/`cde6547c`
(results.json untouched, provenance stamps intact — partial merges never
mask fresh failures). Post-S7 single-seed confirmation (partials in
`/tmp/s7-lab-partial.jsonl`, not merged): row 2 seed 500 PASS
(retire 100 ms, detect 99 ms, restore 16521 ms ≤ 30 s bound), row 9
seed 600 PASS. Rows 3/4/7/12 have no lab oracle (unit-covered);
row 11 is RSS-partial only.

## What S8 (owner/operator) must do

1. On Leno, run Gate 3: `node scripts/live-acceptance.mjs --prepare`,
   `--live --user-present`, the separate remote-plane proof, then the six
   S8 Windows session stages in plan order, then `--cleanup`.
2. Record each S8 stage outcome in its `observed_outcome` block; flip
   `status` only with the observation in hand.
3. Do not create the release tag until local + remote + Windows proof all
   pass; unsigned publication stays blocked by `release.yml`.
4. Review [BLOCKER_REGISTER.md](/workspaces/Tetherplane/docs/BLOCKER_REGISTER.md)
   for decisions only the owner can make (merge/push, `VouchOut`, Pending
   reconcile API, boot-time service).

No push, merge, deploy, tag, or production change has been made from this
branch. Stacked work lands in [SPARK_EXECUTION_PLAN.md](/workspaces/Tetherplane/docs/SPARK_EXECUTION_PLAN.md)
order after owner approval.
