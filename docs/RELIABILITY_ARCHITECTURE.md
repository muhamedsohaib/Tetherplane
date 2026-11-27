# Reliability Architecture

Status: decision record. Base: `main`/`origin/main` (`9c93be6c`). Branch: `research/meta-reliability-architecture`. No production change is authorized by this document.

## Decision

Adopt **B — resilient control plane staged on A hardening**. Reject C (redundant relays) for now. A alone is insufficient.

## Minimum reliable control plane

Four planes, strictly separated:

1. **Routing relay (single active instance).** Routes only. Holds pairing/revocation and *desired* state; never grants authority. Durable state is versioned JSON with atomic rename (`0600`, hash-only credentials), as in `relay/src/devices/registry.ts`.
2. **Device agent (`tetherd`).** Final authority. Launch-bound principal + `LocalPolicyBroker` decide allow/deny/approval before any provider dispatch (`agent/tether-core/src/router.rs`, `agent/tether-core/src/policy.rs`). Durable on-device execution state (idempotency, jobs, audit) survives relay loss.
3. **Capability providers.** Browser (loopback bridge → extension/CDP) and desktop (UIA worker) report *live* per-capability health, not construction-time snapshots.
4. **Supervision.** OS/container supervisor restarts relay and agent with bounded backoff; health signals are pushed, not polled into existence.

The model-facing surface stays exactly six tools: `device`, `files`, `process`, `browser`, `desktop`, `batch`.

## Alternatives

| Criterion (5=best) | A harden relay | B resilient plane (selected) | C redundant relay |
|---|---|---|---|
| Ops complexity | 5 | 3 | 1 |
| Security | 4 | 4 | 2 |
| Overhead | 5 | 4 | 2 |
| Latency | 4 | 4 | 3 |
| Maintainability | 4 | 3 | 1 |
| Recovery | 2 | 5 | 4 only if consistent |
| Deploy cost | 5 | 4 | 1 |
| Compatibility | 5 | 5 | 3 |

C is blocked today: `registry.ts` is a single-writer file (unsafe multi-replica), route ownership/generation fencing would split-brain, and the stable HTTPS OAuth resource/audience breaks on hostname change. Revisit C only after single-relay recovery time is measured insufficient *and* a strongly consistent registry (CAS epochs) exists.

## B increments (in order)

1. **Connection generations everywhere.** Already present: `DeviceRouter` generation UUID per connect, stale results dropped. Extend the same fencing to policy and capability pushes.
2. **Bounded liveness.** Agent heartbeat independent of work execution (see [CONNECTION_STATE_MACHINE.md](/workspaces/Tetherplane/docs/CONNECTION_STATE_MACHINE.md)); relay-side stale retirement. PR #156 is one third of this, not the whole fix.
3. **Durable desired state + acknowledgement.** Versioned desired policy per (account, device, principal); device applies monotonically, acks on a dedicated channel; relay shows `pending` until acked. See [RECOVERY_PROTOCOL.md](/workspaces/Tetherplane/docs/RECOVERY_PROTOCOL.md).
4. **Truthful capability health.** Per-capability `ready|degraded|disconnected|unauthorized|recovering` pushed on connect and on change; `/readyz` reflects freshness, not a static string.
5. **Supervised recovery.** Relay restart + existing Windows agent supervisor (2s→60s backoff); pending work fails `disconnected`, never replays; mutations are protected by the on-device idempotency store.

## Resource budget

Anchor: local `tetherd` idle 12.2–17.4 MiB, cold start ~257 ms (target <250 ms already missed) from `docs/benchmarks/release-candidate-2026-09-21.md`. Relay RSS/RTT are **unmeasured** — no figure in this pack invents them. B must add ≤ one small heartbeat/capability push per interval and must re-run `scripts/bench-local.*` before any reliability claim.

## Non-goals

No new MCP tools, no E2E-secrecy claim for relay transit, no store-and-forward of mutations, no automatic replay of uncertain operations.
