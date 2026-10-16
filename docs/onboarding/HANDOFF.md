# Tetherplane Windows onboarding — continuation checkpoint

Date: 2026-10-16. Branch: `feature/windows-repeatable-onboarding-20261015`.
Worktree: `C:\Users\Sohaib\source\Tetherplane-onboarding`.
Starting pushed checkpoint: `55cdf785ca87684c634cd3025ed54a548e47fa43`.
Use git log and GitHub for the final continuation commits.

Production decision: **NO-GO pending live acceptance and the disclosed remaining
findings.** This document is not approval to change production.

## Authority

Read the three canonical design/roadmap/local-core documents, PLAN.md,
RELEASE-CHECKLIST.md, REVIEW-20261016.md and CONTROLLED-ACCEPTANCE.md.
Keep work isolated; the main checkout has unrelated dirty work. Leno only,
background_only. No live Vaulter/auth/OAuth/client/device/task/policy changes,
no releases or external messages were performed.

## Completed continuation work

- Recovered clean linked worktree and matched GitHub at 55cdf78.
- Original CI runs 38850537547 and 38850537487 completed successfully on all jobs;
  immutable original private kit artifact 12025496021 exists.
- Reproduced the protected runner and three orphan headless test-browser trees;
  did not terminate or bypass the prior local-policy approval_required.
- Final recheck: the old runner exited naturally with code 1 (107/108 relay tests;
  the five-millisecond expiry test raced the wall clock). Its test now uses a
  controlled Date clock and passes; the old PID is not a cleanup target. All
  three orphan Chromium roots remain present, with unchanged creation times.
- Fixed browser shutdown authority: use the fresh profile's private browser
  endpoint even when the launcher exited; require listener closure.
- Added all-resource cleanup covering setup failures, preserved original errors,
  and bounded registration/CDP work. Missing debugger evidence still fails visibly.
- Added pending capacity, socket-source admission and account approval limits;
  ignore spoofed forwarding headers.
- Moved expected-device matching into the serialized approval mutation.
- Added exclusive canonical registry ownership across local processes, explicit
  close/drain and fail-closed closed-registry calls, construction-failure release,
  and automatic Windows/Linux ownership release on process exit.
- Prevented short-code collisions from replacing pending identity.
- Hardened installer receipt identity, prefix validation, destination/state
  reparse-point rejection and directory ACL validation before secret creation.
- Fixed process force-termination delay by refreshing only necessary process
  identity/parent data; unchanged deadline passed in 0.48 seconds.
- Added per-operation desktop metadata traces and hid probe consoles. Clipboard
  assertion diagnostics use hashes, never copied clipboard contents.
- Completed one independent review and one TDD fix pass; findings/rulings and
  four deferred Minor findings are in REVIEW-20261016.md.

## Verification in this turn

Full Rust fmt/Clippy/workspace tests: PASS.
Full Windows Pester: 47 passed, zero failed/skipped/inconclusive.
Chromium fixture tests: 9 passed without launching Chromium.
Ownership/persistence/identity: 11 passed.
Admission/control HTTP: 4 passed.
Collision regressions: 2 passed.
Final candidate sweep: full workspace typecheck/build PASS; available relay
128/128 PASS; other Node packages 246/246 PASS; safe E2E 26/26 PASS using a fresh
agent build; authored unsafe scan and git diff --check PASS.
New GitHub CI must be read for the final pushed branch SHA in Actions; these
local results do not predeclare its outcome.

Full real Chromium OAuth cleanup, full Leno Node sweep and operator-observed
desktop acceptance remain unverified. Stage-B's original cursor failure is
neither skipped nor marked passing. The new probe C# compiled without reading
the desktop.

## Exact stop boundary and next steps

1. Obtain local authorization for scoped cleanup of the three existing Chromium
   trees; revalidate ownership first. Roots 3588, 10544 and 5360 match the three
   test profiles. Runner proc_d555786b4fe04c8c8d873aab61fbd5bc exited naturally;
   do not target its former PID 772, which may be reused.
2. Run isolated real Chromium flow and prove its full process/profile cleanup.
   A missing DevToolsActivePort after a detached launcher is still a reported
   cleanup blocker; no unsafe PID fallback is authorized.
3. Run the two operator-observed coexistence scenarios and then the full Node
   suite. Human input timing does not prove actor attribution.
4. Verify final immutable kit artifact on an explicitly named clean Windows
   environment; complete install/pair/reconnect/reboot/repair/upgrade/uninstall
   and rollback acceptance. No other machine is implicitly authorized.
5. Address or explicitly decide the deferred findings before public production
   release. No publisher signing or internet-wide device onboarding is proven.
6. Only after gates and explicit production authorization, deploy the relay-only
   approval operation under CONTROLLED-ACCEPTANCE.md, preserving the existing
   ChatGPT connection, OAuth clients, state and Leno configuration.

## Runtime limits

JSON registry state is one host/one OS IPC/network namespace, not shared storage
for independent containers or multiple hosts. Reverse-proxy clients share its
socket-source pairing budget; forwarded headers are not trusted. Current agent
transport still requires the same Tailscale tailnet. Device credentials remain
per computer. Exactly six default MCP tools are preserved.
