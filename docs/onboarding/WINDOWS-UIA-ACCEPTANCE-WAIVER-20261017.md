# Project-owner acceptance exception: Windows UIA concurrent activity

**Recorded:** 2026-10-17, Dubai (UTC+04:00)
**Decision:** OWNER-ACCEPTED TEST WAIVER — **NOT A PASS**
**Scope:** Tetherplane draft PR #15, branch `fix/windows-uia-selection-notify-20261017`, tested implementation baseline `18bcee230316e9bfd9a16361dadeea5b56fb1d56`. This exception carries through documentation-only descendants. Reassess if Windows desktop provider, local policy, ownership, or coexistence behavior changes.

## Owner instruction and rationale

The project owner explicitly approved waiving further execution or passing of
`tests/e2e/windows-operator-concurrent.test.ts` as a release-candidate
acceptance criterion. The owner reports having used Tetherplane to update a
LinkedIn profile while simultaneously doing other work on Leno, without
noticeable cursor or foreground interruptions. **That real-use observation
is operator-reported, not independently instrumented evidence.**

Repeated controlled live attempts did not produce a complete simultaneous
input-overlapping-semantic-RPC proof. Some runs revealed genuine acceptance
harness timing/marker-sharing defects; other runs showed baseline physical
activity without adequate per-RPC samples, or no activity during the sample
interval. Each attempt correctly remained unverified, and cleanup checks
confirmed no remaining test-owned fixtures. No test result is relabeled
`PASS`.

## What the exception permits

- Treat the **additional operator-active overlap measurement** as
  **waived / risk accepted for this candidate**, rather than repeatedly
  requesting that the owner move the mouse for another timed test.
- Continue the independent PR-wide integration/security review,
  clean-device lifecycle acceptance and release-readiness assessment without
  treating this single omitted measurement as an automatic blocker.
- Retain the harness and its regression tests; retain the normal
  test skip/approval logic. Do not fake samples, lower thresholds, disable
  safety assertions, or claim that concurrent physical activity was proved.

## Evidence supporting the limited decision

- Background-only WinForms `set_value`, `invoke` (including application-
  observed effect), and `select` behavior has been verified on
  test-owned fixtures, with selection-notification and cleanup regressions.
- The final-head local repository Rust/TypeScript gates were green and
  background-safe E2E reported 53 passed, 0 failed, 2 approval-gated skips.
- Hosted Windows/Ubuntu CI was green on the implementation baseline.
  The Windows PR workflow ran 20 consecutive fixture-lifetime iterations
  and reported zero remaining lifetime fixtures.
- The operator's uninterrupted LinkedIn workflow is additional
  experiential evidence, **not** a substitute for the missing automated
  overlap trace.

## Constraints that are **not** waived

1. The **local policy broker remains the final authority**:
   `background_only` remains the default; ownership, approval, clipboard,
   cursor/focus, tab and window protections continue unchanged. This waiver
   issues no ForegroundLease and authorizes no physical keyboard or mouse
   takeover, policy bypass, or unauthorized process termination.
2. The separate **real Chromium OAuth loopback-callback / CSP / cleanup**
   test remains unverified. Passing B8 browser-coexistence and ordinary
   Chromium/CDP tests does not prove that skipped callback test passed.
3. Independent final-head PR review, clean-device installation/upgrade,
   reboot/reconnect/repair/rollback/uninstall, identity/authorization checks,
   security findings, and release/production approval remain separate.
4. PR #15 remains draft/unmerged until the applicable remaining review
   and release requirements are independently resolved. No deployment,
   release tag, mainline merge, or external announcement is approved here.

**Residual risk explicitly accepted:** On this release candidate there
will be no instrumented proof that operator-generated input continued
during the exact 25–51 ms semantic desktop RPC intervals. This is an
evidence exception, not a finding that coexistence is broken or a claim
that it has been formally demonstrated.

**Reopening conditions:** If future testing or real operation shows cursor,
focus, clipboard, human-owned resource or policy interference, immediately
stop affected activity, investigate, and reconsider this exception. Also
reconsider when material desktop/provider/policy behavior changes.

## Traceability

- Detailed attempts and negative evidence:
  `docs/onboarding/WINDOWS-UIA-SELECTION-NOTIFICATION-20261017.md`.
- Controlled release and OAuth/browser acceptance requirements:
  `docs/onboarding/CONTROLLED-ACCEPTANCE.md`.
- Canonical coexistence invariants:
  `docs/superpowers/specs/2026-09-17-tetherplane-design.md`.
- Owner approval was supplied directly in the project conversation on
  2026-10-17. This record does not purport to be a cryptographic signature
  or independently verified operator-authentication event.
