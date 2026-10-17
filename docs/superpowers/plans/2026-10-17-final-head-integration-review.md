# Final-head integration review and corrections — 2026-10-17

**Goal:** Independently review PR #15 at 8259abdada4b2ac0447098ba0b2eb653f4639620 and dependency PR #14 at b192b9e4fb37025e58786032066e9fa9550f1c35 against main 5feee084eb24bfd4831ab42840bb5f10dafc8113; reproduce and correct substantial confirmed findings.

**Architecture:** Preserve capability kernel, providers, adapters, transport and local Policy Broker boundaries; exactly six default MCP tools. Separate source review, automated regression evidence and live operator acceptance.

**Execution:** Native implementation in the existing isolated Leno worktree, independent read-only domain reviewers, strict RED -> GREEN for each correction.

## Constraints
- Leno only; background_only. Preserve the installed agent, production, pairings and local security policy.
- No physical foreground control or self-issued ForegroundLease. Live acceptance waits for renewed exact 15-minute scope and operator availability.
- Do not merge PRs, deploy, rewrite history or touch synced sources.
- No secrets in output, logs, fixtures or Git.
- Follow canonical 2026-09-17 design, roadmap and local-core plan.

## Tasks
- [x] Verify Leno status, worktree status/branch/log/remotes and exact head.
- [x] Read canonical architecture, roadmap and local-core plan; read SECURITY.md.
- [x] Verify current GitHub draft state and both named CI runs; inspect original failed Rust job log.
- [ ] Review every changed source/configuration/test file, with independent auth, relay and Windows reviewers; review docs and test safeguards centrally.
- [ ] Reproduce the candidate browser interaction content-type/CSRF bypass through isolated HTTP tests; implement only if RED is witnessed.
- [ ] Reproduce the candidate concurrent access-log byte-cap race with temporary files; implement only if RED is witnessed.
- [ ] Validate any further substantial review finding before extending this plan.
- [ ] Run focused regression tests, Rust fmt/Clippy/workspace tests, TypeScript typecheck/test/build, unsafe scan, PowerShell parser and diff hygiene. Run full automated suites with operator switches explicitly unset; no stress on Leno.
- [ ] Record local release/Pester availability separately, without bypassing Code Integrity or changing installed software.
- [ ] Obtain independent review of corrections, commit focused verified changes and push feature branch; verify exact-head Windows/Ubuntu CI.
- [ ] Save line-specific findings, coverage, tests and remaining live/clean-device acceptance blockers.

## Review focus
- Browser-compatible simple POST content types must not bypass consent/login CSRF.
- Concurrent unauthenticated diagnostic events must not exceed the configured disk budget or create an unbounded pending queue.
- Installer reruns/rollback must preserve unrelated human tasks/state and verify candidate ownership.
- Operator phase accounting, cleanup and test switches must not manufacture foreground authority or a live acceptance pass.
- A green CI rerun does not establish the root cause of an earlier unnamed process exit.

## Verified Chat-mode continuation — 2026-10-17

Work mode stopped with uncommitted work. Tetherplane Native Web Test in ordinary Chat mode recovered the isolated Leno worktree, retained every uncommitted change and inspected the canonical specification, roadmap and local-core plan. No production, security policy, active user window, installed agent or other worktree was modified.

Confirmed focused test evidence:
- 16/16 relay/authentication HTTP and concurrent access-log tests passed.
- 7/7 Pester Windows onboarding security tests passed, including reparse/junction and managed-leaf protection.
- 9/9 operator-gate/read-only sampler tests passed. The new fast sampler test demonstrated RED on the former 20 ms lower-bound restriction and GREEN after allowing 2 ms polling with reduced JSON snapshot I/O.
- Rust fmt, Clippy and full workspace tests passed.
- `pnpm -r build`, `pnpm -r typecheck`, and `pnpm -r test` passed after an isolated new-test TypeScript guard fix. E2E: 48 passed, 0 failed, 2 intentionally skipped; live approval switches explicitly unset.
- `python scripts/check-no-unsafe.py`, `git diff --check`, and PowerShell parser check passed.

Review conclusions: explicit interaction POST media-type allowlist prevents browser-simple POST CSRF bypass; synchronous UTF-8 byte reservations bound queued access-log writes even under concurrent arrivals; Windows reparse checks protect the pairing leaf and launch-arguments leaf. New tests exercise these using isolated HTTP providers, temporary files and Pester fixtures, not production. The remaining limitations are an unexplained previous Rust CI abnormal exit, separate clean-device install/upgrade acceptance, independent final-head merge review, and actual operator–AI concurrent desktop proof.

Live acceptance was attempted only inside the recorded 19:35–19:50 Dubai window. The tests were deliberately fail-closed: one run witnessed baseline human movement but failed phase-acknowledgment; another completed all three managed UIA semantic actions but obtained inadequate per-RPC observer samples; the fast observer later collected 648 baseline samples without physical input and stopped before any action. Do **not** mark live coexistence as passed. The approval has expired. Any future live test requires a new exact scoped approval and operator activity. No foreground lease or physical input was generated.

The source patch is suitable for focused commits and a new draft-PR CI run after final staged-diff review. A complete independent review of the enlarged PR #15 stack remains an integration blocker, even if these focused fixes and CI pass.
