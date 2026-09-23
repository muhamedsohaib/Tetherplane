---
name: strict-tdd
description: Strict test-driven development workflow. Use for every Tetherplane feature, defect fix, regression, or behavior change.
---

# Strict TDD

Never implement a behavioral change before establishing the failing test unless reproducing the failure itself requires instrumentation.

Use this cycle:

1. Reproduce the real failure.
2. Identify the expected behavior.
3. Write the smallest regression test.
4. Run it.
5. Verify it fails for the intended reason.
6. Implement the minimum behavior needed.
7. Run the targeted test.
8. Keep refactoring only while green.
9. Run the subsystem test suite.
10. Run repository-level gates appropriate to the change.

## Failure discipline

A failing test is useful only when its failure demonstrates the intended missing behavior.

Do not accept failures caused by:

- syntax errors
- missing imports unrelated to the intended defect
- corrupted fixtures
- test infrastructure failure
- unavailable dependencies
- unrelated environment problems

Fix those first, then establish the intended RED state.

## Regression requirements

Every production defect should get a regression test when practical.

Tests should verify behavior, not implementation details.

For concurrency, lifecycle, persistence, ownership, policy, or security bugs, test the invariant directly.

## Live integration

Unit tests do not substitute for real integration evidence.

When the defect involves:

- Chrome
- Windows persistence
- process lifecycle
- remote transport
- browser service workers
- WebSockets
- permissions

perform a live acceptance test after automated tests pass.

## Evidence

Do not print PASS merely because execution continued.

Check actual exit status.

Treat a trailing PASS marker as invalid if an earlier required command failed.

Do not claim completion without fresh evidence from the current run.