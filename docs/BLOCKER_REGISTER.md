# Blocker Register (post-S7)

Open items against the S1–S7 release candidate. Nothing here blocks
Linux Gate 1, which is green; items B1–B3 block any Windows or
unattended-readiness claim, B4–B6 are specified follow-ups, B7–B9 are
recorded limitations.

## B1 — Gate 3 Windows acceptance not executed (owner/operator)

All six S8 stages in `scripts/live-acceptance-plan.json`
(`windows_locked_workstation`, `windows_unlock_recovery`,
`windows_sleep_wake`, `windows_reboot_logon`,
`browser_runtime_onboarding`, `windows_resource_baseline`) report
`unverified` from Linux. Execution requires the operator on Leno per
[WINDOWS_ACCEPTANCE_PLAN.md](/workspaces/Tetherplane/docs/WINDOWS_ACCEPTANCE_PLAN.md)
and `docs/live-acceptance.md` §5. Never self-certify from Linux.

## B2 — Relay RSS/RTT unmeasured (blocks "unattended-ready")

[RELEASE_QUALITY_GATES.md](/workspaces/Tetherplane/docs/RELEASE_QUALITY_GATES.md)
requires measured relay RSS/RTT for the unattended-ready claim. Row 11
is RSS-partial only (row2-stability bounds); CPU/disk-full pressure and
relay RTT have no oracle. The claim stays blocked until measured.

## B3 — Chromium-dependent tests unverifiable on Linux (environmental)

browser-bridge 3 failures + e2e B8 fail with "expected an installed
compatible Chromium executable"; 3 e2e skips are Windows-only. These
are pre-existing environmental gaps, not regressions. They clear on a
host with compatible Chromium (Leno Gate 3) or a Linux Chromium install.

## B4 — Pending reconcile has no owner-visible recovery path (design)

Since S5, a crash between reserve and complete leaves the key `Pending`
(`action_unverified`) by design — truthful, never auto-replayed — but
there is no API for the owner to inspect canonical state and resolve
the key. Needs an owner-API design decision; do not silently add
auto-retry or TTL expiry.

## B5 — Live evidence contexts not yet wired (specified follow-up)

S7 machinery is complete and tested (`execute_with_context`,
generation supersession), but no live caller passes a context yet, so
production records carry explicit `connection.*` gaps. Wiring (small,
no design risk): mint a per-connection generation UUID in
`connect_and_run_with_timing` (`agent/tetherd/src/relay_ws.rs`),
thread it through `handle_inbound` into `execute_with_context`
(5 test call sites updated alongside), and pass an explicit stdio
context from the `main.rs` stdio loop.

## B6 — VouchOut integration needs owner approval (decision)

S7 emits `VouchOut`-ready evidence with no dependency, per
[SECURITY_INVARIANTS.md](/workspaces/Tetherplane/docs/SECURITY_INVARIANTS.md).
Any forwarding, verification, or canonical-JSON (JCS) conformance work
for a real `VouchOut` consumer is a separate owner-approved change.

## B7 — Cold-start target needs full-stack re-measurement (data)

Direct-agent cold start measures 11.2 ms on Linux (S7 tree), but the
gates doc records ~257 ms full-stack vs the <250 ms target. Re-measure
the full stack and the Windows baseline (`windows_resource_baseline`
stage) before claiming the target.

## B8 — Windows session limits are stated, not solved (owner decision)

No agent before logon / after logoff with AtLogOn registration;
secure-desktop surfaces not automatable by design; sleep/wake certified
per-machine only. A boot-time service is a separate owner-approved
design change. Recorded in the plan; must not be presented as certified.

## B9 — Fault-lab rows 3/4/7/12 have no oracle (coverage)

Covered by unit suites only. Row 2/9 N=20 evidence is Linux simulation.
A full N=20 re-run was deliberately not repeated post-S7 (carried with
provenance); single-seed row 2/9 confirmation passed on the S7 tree.
