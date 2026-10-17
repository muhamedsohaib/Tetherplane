# Isolated Chromium OAuth Callback Acceptance — 2026-10-17

## Goal
Make the existing Chromium OAuth loopback-callback/CSP and private-browser cleanup test an **executed, non-skipped** GitHub-hosted Windows and Ubuntu PR acceptance gate for Tetherplane, without affecting Leno's human-owned browser profiles or installed agent.

## Canonical authority
- `docs/superpowers/specs/2026-09-17-tetherplane-design.md`
- `docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md`
- `docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md`

## Constraints
- Leno isolated worktree only for source, typecheck and browser-free contract testing.
- Do not launch or terminate Leno's active/human-owned Chromium browsers, touch other devices, print credentials, or change the installed agent or production.
- The callback test uses a fresh private profile, loopback listeners, synthetic temporary OAuth storage and ephemeral CDP ports. Every cleanup failure is fatal. Never kill a browser by bare/recycled PID.
- Preserve the current six-tool MCP surface, background_only policy and existing Tetherplane-owned resource restrictions.
- PR #15 remains draft and unmerged. No release/deployment in this plan.

## Implementation steps
1. Verify clean feature branch/commit, read the three canonical documents, inspect browser resolver, callback test, cleanup semantics, and CI skip evidence.
2. Write failing regression tests proving required Chromium cannot silently skip when absent and Windows profile cleanup targets the actual browser executable (including Edge).
3. Implement minimal fail-closed callback-test changes. Verify RED→GREEN locally without launching any Leno browser.
4. Add an **isolated matrix job** on GitHub-hosted Windows and Ubuntu. Discover the existing installed Chromium via Tetherplane's browser resolver; set the callback-test binary and required flag in the job; fail on absent binary or any test/cleanup failure. Do not weaken assertions or merely grep logs for a pass.
5. Run local Rust/TypeScript checks and browser-free focused regression checks; perform fresh staged-diff review, commit and push the verified task branch.
6. Verify that the new isolated job runs on the exact commit for Windows and Ubuntu, test is **not skipped**, OAuth callback state and CSP assertions pass, browser endpoint closes and no test-owned profile processes remain; verify unchanged repository CI gates. If failing, reproduce/diagnose the actual log and fix with another RED→GREEN cycle.
7. Record exact final-head evidence, any remaining limitations, Git state, and release blockers. Preserve the owner UIA waiver as waived (not passed).

## Acceptance
- Dedicated isolated OAuth callback CI job passes **both** Windows and Ubuntu on final SHA; logs show the named test passing without SKIP.
- Test-owned browser teardown passes; original user browsers are untouched.
- Regular PR code checks remain green; worktree clean and pushed; PR #15 draft/unmerged.
