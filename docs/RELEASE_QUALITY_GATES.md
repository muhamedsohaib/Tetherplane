# Release Quality Gates

No gate may be skipped, narrowed (`--deselect`, `-k` filters, `skip`/`xfail`), or redefined to pass. A red test covering a change is the requirement.

## Gate 1 — Linux simulation (CI, every change)

- `cargo test --workspace` (fmt/clippy per CI), `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`
- `npm run fault-lab` — rows 1–9, 11, 12 pass; row 10 clock-skew part only, labeled simulation
- Six-tool assertion: tool list is exactly `[batch, browser, desktop, device, files, process]`
- Benchmarks: `scripts/bench-local.sh` — idle RSS and cold start recorded; regression beyond the recorded envelope blocks; the <250 ms cold-start target is currently **missed** (~257 ms) and must be reported, not hidden

This gate certifies Linux behavior only. It never certifies Windows desktop, lock, sleep/wake, or real browser-profile behavior.

## Gate 2 — Truthfulness checks (part of Gate 1, named separately)

- Half-open blackhole detects within bound (no hang) — fails on `main` until Spark S1/S2 land
- Provider killed → per-capability `disconnected`/`degraded`, never `available:true` — fails until S3
- Unauthorized probes denied before, during, and after recovery; ambiguous mutation executes exactly once (counter-verified)

## Gate 3 — Windows acceptance (operator-present, release only)

[WINDOWS_ACCEPTANCE_PLAN.md](/workspaces/Tetherplane/docs/WINDOWS_ACCEPTANCE_PLAN.md) executed on the Windows machine including the new lock/sleep/reboot stages. Requires clean `main == origin/main`. Emits `LOCAL_LIVE_ACCEPTANCE` / `RELEASE_TAG_ALLOWED` only on observed success.

## Gate 4 — Release integrity

Signed candidate required; unsigned tag publication remains blocked (`release.yml`). No merge, deploy, release, or production relay/auth change without explicit owner approval. Stacked PRs land in the order in [SPARK_EXECUTION_PLAN.md](/workspaces/Tetherplane/docs/SPARK_EXECUTION_PLAN.md).

## Evidence required to claim "unattended-ready"

All of: Gate 1+2 green on the release commit; fault-lab N≥20 seeded logs with measured detect/restore times (restore ≤30s after infra return); Gate 3 operator log; per-capability readiness demonstrated under provider failure; relay RSS/RTT measured (currently unmeasured — the claim is blocked until measured). Test counts, compilation, and diagrams are not evidence.
