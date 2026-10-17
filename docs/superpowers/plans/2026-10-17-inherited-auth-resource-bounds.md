# Inherited auth resource bounds implementation plan

> **For agentic workers:** Use the executing-plans workflow for the approved
> continuation, strict TDD, independent review and verification before completion.

**Goal:** Resolve the two concrete availability findings from the inherited-stack
review before treating PR #15 as ready for integration.

**Architecture:** Keep the existing TetherAuthServer boundary. Bound and lazily
expire its local browser form-proof cache; match the installed OIDC provider's
case-insensitive registration route and single trailing-slash alias when applying
the existing registration budget. Preserve local policy and all identity, scope,
cookie, consent, persistence and device-binding semantics.

**Tech Stack:** TypeScript, Node HTTP tests, the lock-pinned OIDC provider and
temporary SQLite adapter.

**Spec:** `../specs/2026-09-17-tetherplane-design.md`, the canonical roadmap/local
core plan, and `2026-10-14-tether-auth-browser-migration.md`.

## Global constraints

Leno only; background_only; loopback fixtures only; preserve the
installed agent and production; no credentials in output; no foreground tests;
feature branch `fix/windows-uia-selection-notify-20261017`.

## Review focus

- Abandoned forms cannot grow storage without a fixed bound.
- Capacity rejection must preserve existing valid submissions.
- Existing UID refresh must remain available at capacity.
- Expired entries must release capacity without a timer or process restart.
- Provider registration aliases must share a budget; registration-management
  child paths retain the existing exemption.

## Tasks

- [x] Add real HTTP regressions in `auth/test/resource-bounds.test.ts`.
  Fill 1,024 live HTML interaction proofs, require a new UID to fail with 503 and
  Retry-After, preserve existing UID refresh/submission, advance controlled time,
  and require capacity recovery. This fails on the current unlimited cache.
- [x] Through the real installed OIDC provider and a temporary SQLite adapter,
  register at `/REG`, `/reg/`, and `/ReG/` under a one-request budget. Require
  subsequent canonical and alias registration to return 429. This fails when an
  alias bypasses the server's exact `/reg` check.
- [x] Witness both failures, then add only the cache bound/expiration and route
  normalization needed to make the regressions pass. Do not evict live proofs.
- [x] Run targeted tests, whole-workspace typecheck/build, all Node packages and
  the safe E2E selection. Rust source is unchanged. Keep local release/Pester
  blocked by the recorded Code Integrity denial; do not bypass policy.
- [ ] Record results, commit/push, update the draft PR to the final scope, and
  obtain fresh head CI. Keep merge held pending sufficient final review/checks.

## Review decisions

The five-minute cache lifetime already exists. Use a fixed 1,024-entry ceiling
consistent with bounded pending resources elsewhere in this stack. Reject new
forms at capacity rather than evicting another active user. Pruning occurs on
issuance, bounding memory even during abandoned interactions without adding a
background timer. Case folding and one optional trailing slash mirror the
lock-pinned provider router; registration-management child paths stay outside
the dynamic-registration budget.

## TDD and review evidence

Both regressions failed against `b130db9`: the 1,025th form returned 200 instead
of 503; registration at `/REG` did not consume the budget and the next canonical
registration returned 201 instead of 429. The focused correction made both tests
pass, including all three real-provider aliases, no active-proof eviction,
existing UID refresh and controlled-time expiry recovery. A focused independent
completion review found no concrete blocker. No production/runtime authority was
changed. Complete verification results are recorded in the onboarding UIA
continuation document and PR #15.

Final local gates after the auth corrections passed: Rust format/Clippy and
138 workspace tests; whole-workspace TypeScript typecheck/build; 378 non-E2E
Node tests (including 82 auth and 130 relay tests); 29 safe E2E tests including
the UIA app-state/cleanup proof; unsafe scan and diff hygiene. No test in these
selections failed or skipped. The three operator-observed E2E files remain
deferred, and the local release/Pester Code Integrity blocker remains explicit.
PR/push CI at the preceding `b130db9` passed on Windows and Ubuntu; final-head CI
must be rechecked after this correction is committed and pushed.
