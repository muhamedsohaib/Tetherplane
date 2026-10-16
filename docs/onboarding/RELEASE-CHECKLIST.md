# Windows onboarding release continuation — 2026-10-16

Baseline: `55cdf785ca87684c634cd3025ed54a548e47fa43`
Branch: `feature/windows-repeatable-onboarding-20261015`
Worktree: `C:\Users\Sohaib\source\Tetherplane-onboarding`

The canonical design, roadmap, local-core plan, onboarding PLAN and HANDOFF govern this continuation. No live relay, OAuth, device registration, policy, scheduled-task or foreground changes are authorized here.

## Execution plan

1. Recover state and CI. Verify clean linked worktree, branch, HEAD and remote; inspect both workflow outcomes and private kit evidence.
2. Reproduce Chromium teardown failure with an isolated loopback debugger fixture. Correct cleanup independently of launcher lifetime; require bounded shutdown and leak/error assertions. Existing protected processes remain untouched pending local-agent authorization.
3. Review pairing ownership, durable writes, restart/replay, input validation and enrollment abuse. Reproduce material defects before minimal fixes.
4. Review installer, repair, supervisor and package integrity. Verify clean-device limitations honestly; preserve existing installation and user files.
5. Investigate coexistence evidence and add attribution where justified. Do not run desktop/browser foreground fixtures unattended.
6. Run available complete gates, obtain an independent branch review, commit and push verified work. Prepare exact deployment and rollback instructions.
7. Request only the approvals needed for protected cleanup, operator-observed coexistence, a named new Windows test device and eventual live relay deployment.

## Evidence ledger

- Recovery: canonical repository documents read on Leno. Clean linked worktree at baseline matches GitHub.
- CI 38850537547: Linux and Windows quality jobs completed successfully.
- CI 38850537487: relay-approval and Windows kit jobs completed successfully.
- Private kit artifact 12025496021: immutable baseline SHA; ZIP verification passed in Windows CI. This is not clean physical-device acceptance.
- Leno native device.status: Windows x86_64, agent 0.1.0, background_only.
- Existing runner proc_d555786b4fe04c8c8d873aab61fbd5bc: still running.
- Three existing test browser roots: 3588 (03:55:33Z), 10544 (04:05:22Z), 5360 (04:18:49Z); installed Playwright Chromium 1244; unique test profiles match HANDOFF. Launcher parents 12800, 12584 and 8388 no longer exist. No termination attempted.
- Ruling: continue the existing onboarding worktree and completed implementation plan; do not recreate or rerun completed feature tasks. Record release continuation here because cloud skill shell helpers are not installed on Leno. Cost if wrong: bookkeeping format differs, with no runtime effect.
- Production release remains NO-GO until all required technical and physical acceptance gates are proven.

## Continuation results

- Source recovery complete; completed onboarding features were not rebuilt.
- Independent review completed; four Important findings entered one TDD fix pass.
- Ruling: code collision regraded Important because legacy approval can select
  the wrong pending device. Bounded unique-code allocation now passes two
  deterministic tests that failed before implementation.
- Registry ownership: one canonical JSON state owner per host/IPC namespace,
  fail-closed competing opens, drained close, failed-open release and restart
  after abrupt process exit proven in isolated fixtures.
- Admission: ten starts per socket source/minute, bounded source tracking;
  forwarding headers ignored. Cost: proxy clients share a budget.
- Installer: ACL/receipt/reparse containment regressions witnessed RED/GREEN.
- Chromium: nine loopback fixtures pass without launching a browser; missing
  private debugger evidence is a visible failure requiring scoped operator recovery.
- Process: unchanged two-second force-fallback test failed twice; minimum
  process metadata refresh made it pass in 0.48 seconds. Full Rust gates pass.
- Final candidate typecheck/build, 128 safe relay tests, 246 other Node tests,
  26 safe E2E tests, 47 onboarding tests, unsafe scan and diff checks pass.
- Review decisions, deferred findings and exact live acceptance/rollback steps
  are in REVIEW-20261016.md and CONTROLLED-ACCEPTANCE.md.
- Existing protected processes, operator-observed coexistence, real Chromium
  cleanup, clean-device lifecycle and live relay deployment remain open.
