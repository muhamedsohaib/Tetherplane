# Concurrent Human/AI Windows UIA Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) for tracking.

**Goal:** Prepare a reproducible operator-active Windows UIA acceptance gate that records actual mouse/input activity *concurrently* with candidate semantic actions and verifies reliable cleanup, without exercising foreground control before renewed approval.

**Architecture:** A test-owned, bounded, read-only PowerShell sampler polls Windows cursor motion, input timestamps, foreground process ownership, and clipboard sequence without retaining sensitive values. A Node E2E harness starts an off-screen non-activating WinForms fixture through a separate candidate Compact MCP session; it brackets `set_value`, `invoke`, and `select` with phase markers and requires evidence of operator input inside an action phase. A dry-run sampler regression remains eligible for ordinary CI; the actual operator-active test stays explicitly opt-in and is prohibited without fresh human approval.

**Tech Stack:** Node 22+ test runner / TypeScript, Windows PowerShell 5.1, Win32 P/Invoke (read-only), WinForms test-owned fixture, MCP SDK.

**Spec:** `docs/superpowers/specs/2026-09-17-tetherplane-design.md`; `docs/superpowers/plans/2026-09-20-tetherplane-windows-desktop-plan.md` and `docs/onboarding/WINDOWS-UIA-SELECTION-NOTIFICATION-20261017.md`.

## Global Constraints

- Run only on Leno from `C:\Users\Sohaib\source\Tetherplane\.worktrees\windows-uia-selection-notification-20261017`.
- Preserve `background_only`, the installed Leno agent, human applications, other worktrees and production. Never self-issue a foreground lease or bypass a local policy denial.
- The previous 15-minute authorization expired; do **not** perform operator-active acceptance until renewed, scoped approval with operator availability.
- Probe records only counts, booleans, phase labels and elapsed durations. Never store typed input, clipboard contents, window titles, raw cursor coordinates or raw foreground handles.
- Test-owned fixture must be non-activating/off-screen, time-bounded, explicitly stopped and verified closed. Sample process must be bounded and stopped.
- A test switch is *not* authorization. Test-specific approval deadline must be supplied only after actual approval.
- Keep existing untouched-desktop acceptance assertions intact and separate from human-active observations.

## Review Focus

- User moves mouse *outside* the action phases: fail/inconclusive, not a pass.
- Sampler starts late or marker races an action: explicit acknowledgment before `desktop.act`.
- Operator clicks another human-owned app: do not confuse voluntary foreground changes with automated focus theft; protect test-owned fixture by PID.
- Lost MCP/observer process: bounded TTL, stop file, wait for exit and report incomplete cleanup.
- Clipboard changes during a test: reject the run without inspecting or logging contents.

---

### Task 1: Read-only Windows activity sampler

**Files:**
- Create: `tests/e2e/fixtures/windows-operator-activity-probe.ps1`
- Create: `tests/e2e/windows-operator-activity-probe.test.ts`

**Interfaces:**
- Probe args `-MarkerPath`, `-SnapshotPath`, `-StopPath`, `-LifetimeMs`, `-SampleIntervalMs`, `-OwnedPid`.
- Marker values: `baseline`, `set_value`, `invoke`, `select`, `post`.
- Snapshot JSON: `ready`, `active_phase`, `sample_count`, `cursor_motion_samples`, `input_change_samples`, `clipboard_change_samples`, `owned_foreground_samples`, `phase_samples` dictionary, `elapsed_ms`, `finished`.
- Only the bounded probe process owns its snapshot file; the test controls only marker and stop files.

- [x] **RED:** Write a Windows-only dry-run test that launches the sampler with test-owned files, switches `baseline` to `select`, waits for acknowledgment/snapshot and stop, and asserts a valid summary without raw personal values.
- [x] **Verify RED:** `node --test tests/e2e/windows-operator-activity-probe.test.ts` on Leno fails because the sampler file does not exist.
- [x] **GREEN:** Implement the minimum read-only sampler with 20-50ms bounded polling, marker acknowledgment via `active_phase`, periodic summary snapshots, stop-file cleanup and a 30s lifetime fallback. No input or clipboard mutation APIs.
- [x] **Verify GREEN:** Re-run the focused sampler test, then `pnpm --filter @tetherplane/e2e typecheck`; inspect output.

### Task 2: Explicitly gated concurrent acceptance

**Files:**
- Create: `tests/e2e/windows-operator-concurrent.test.ts`
- Modify: `docs/onboarding/WINDOWS-UIA-SELECTION-NOTIFICATION-20261017.md`

**Interfaces:**
- Accept only `TETHERPLANE_OPERATOR_ACTIVE_ACCEPTANCE=1`, `TETHERPLANE_INTERACTIVE_DESKTOP_ACCEPTANCE=1`, an unexpired bounded `TETHERPLANE_OPERATOR_APPROVAL_DEADLINE`, and a matching `TETHERPLANE_APPROVED_CANDIDATE_SHA` before the test is enabled.
- Start the existing local Compact MCP harness, test-owned offscreen fixture, and probe; perform `set_value`, `invoke`, and `select` only against verified `origin=tetherplane` nodes.
- Before each action set the probe marker and wait for `active_phase` acknowledgment.
- Assert managed Value/Invoke/Selection state, exact `Beta` and one managed selection event; probe must see human input and cursor movement *inside at least one action phase*, zero owned-foreground samples and zero clipboard changes. Do not assert a static cursor under active human movement.
- Require fixture and sampler exit; use only their own handles, stop files and bounded cleanup. Report inconclusive operator input if none sampled during actions.

- [x] **RED:** Add a pure gating assertion test covering disabled-by-default, wrong SHA, expired/out-of-range approval, and valid short-lived approval (no fixture creation).
- [x] **Verify RED:** Run the gating test, proving the required helper is missing.
- [x] **GREEN:** Implement the smallest gating/helper and opt-in concurrent test. No foreground activation. Never run the active path without a new scoped approval.
- [x] **Verify GREEN:** Run the gating test, TS typecheck and ordinary test suite (active test must be skipped). Ensure no test-created app remains.

### Task 3: Repository acceptance and delivery

**Files:** `.npmrc`, this plan, the read-only PowerShell sampler, the approval/overlap helper, its unit test, the sampler dry-run test, the opt-in concurrent E2E test, and the existing onboarding log.

- [x] Run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `pnpm -r typecheck`, `pnpm -r build`, `pnpm -r test`, `python scripts/check-no-unsafe.py`, and `git diff --check`.
- [x] Review the new test for hidden foreground actions, resource ownership, bounded lifetime and sensitive logs.
- [ ] Commit and push only verified feature branch changes; do not merge PR #15 or install candidate software.
- [ ] Report test readiness vs unexecuted operator-active gate separately; request scoped approval only after preparation QC passes.
