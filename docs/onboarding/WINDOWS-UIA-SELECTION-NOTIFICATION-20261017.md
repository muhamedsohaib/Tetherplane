# Windows UIA background selection app-state regression — 2026-10-17

Status: isolated TDD fix, **not deployed**. Branch: `fix/windows-uia-selection-notify-20261017`, based on verified `1f8e220`.

## Canonical constraints
Use the 2026-09-17 design, implementation roadmap, local core plan and 2026-09-20 Windows desktop plan. Exactly six MCP tools; local Policy Broker final; `background_only` and no physical keyboard/mouse/focus/global clipboard changes; no authored unsafe Rust.

## Reproduced live failure (installed Leno agent 0.1.0)
A test-owned off-screen WinForms ListBox was registered as `origin=tetherplane` and remained `focused=false`. Selecting its Beta item via `desktop.act(select)` returned `verified=true`, while:
- native `LB_GETCURSEL` and managed `SelectedIndex` both became index 1;
- managed `SelectedItem` was still Alpha;
- `SelectedIndexChanged` event count remained zero, confirmed after >900 ms.

The native provider currently sends `LB_SETCURSEL` but omits the parent `WM_COMMAND` / `LBN_SELCHANGE` notification. A separate test-owned diagnostic form confirmed that sending that notification with control ID zero makes managed `SelectedItem=Beta` and raises one event, without taking foreground focus. No fixture processes remained.

## TDD and narrow fix
1. Add a Rust Windows unit test requiring a WinForms-specific selection notification tuple (`WM_COMMAND=0x0111`, `LBN_SELCHANGE=1` in high word) and explicitly no claim for untested non-WinForms classes. Witness RED before implementing helper.
2. Strengthen `tests/e2e/desktop-coexistence.test.ts` to require the exact requested selection `Owned Beta`, not merely a nonempty selected value. This remains an operator-observed interactive-Windows gate (skipped on headless CI by existing test contract).
3. Change only the UIA background-native listbox selection path: after a successful `LB_SETCURSEL`, send a bounded notification to the list's UIA parent for recognized WinForms listboxes; return `verified=false` for other native list controls until their app-level notification semantics are established. Preserve detailed transport/notified metadata and ownership/policy controls.
4. Run targeted regression, full Windows and Linux quality gates and all available non-interactive tests. Obtain fresh CI for exact SHA. Do not mark live acceptance passed merely because CI compiles.
5. Re-test the actual candidate on an authorized isolated runtime on Leno after local policy permits a verified build, without modifying its installed agent or other user resources. If Code Integrity blocks fresh local Rust builds, preserve this blocker and keep the release gate **NO-GO**.

## Out of scope
No repo history rewrite, relay/OAuth/pairing changes, Agensi publication, provider-neutral semantics change, user-owned window mutation, foreground lease self-issue or other-device work.

## 2026-10-17 isolated worktree verification

- Confirmed branch fix/windows-uia-selection-notify-20261017 at 1f8e220, with the original three-file uncommitted state preserved.
- RED: cargo test -p tether-desktop-provider --lib selection_notification_tests failed because winforms_selection_notification was unresolved.
- GREEN: focused Rust selection-notification unit test passed after adding a WinForms-specific bounded WM_COMMAND/LBN_SELCHANGE path.
- Selection result now records app_notified; other native list classes cannot claim verified application-level notification from LB_SETCURSEL alone.
- Enhanced e2e expectation requires exact fixture managed state Owned Beta. The test is explicitly opt-in with TETHERPLANE_INTERACTIVE_DESKTOP_ACCEPTANCE=1 because the fixture activates a foreground window; it must not run in unattended background_only validation.
- cargo fmt --all -- --check: PASS.
- cargo clippy --workspace --all-targets -- -D warnings: PASS on final source.
- cargo test --workspace: PASS.
- pnpm install --frozen-lockfile --prefer-offline: PASS (fresh isolated-worktree dependencies).
- pnpm -r build: PASS.
- pnpm -r typecheck: PASS.
- pnpm -r test: PASS with one interactive desktop acceptance test skipped.
- git diff --check: PASS.
- Interactive Leno candidate-runtime WinForms app-state/SelectedIndexChanged acceptance remains NOT RUN; native message transport delivery alone is not conclusive application-state verification. Release/production gate remains NO-GO.
- No installed-agent replacement, foreground lease, production change, commit, or push was performed.


## 2026-10-17 non-activating candidate-runtime acceptance on Leno

The isolated worktree's freshly built target/debug/tetherd.exe was exercised through its own Compact MCP runtime. The installed Leno agent, production relay, other worktrees, and human-owned windows were not changed.

An opt-in non-activating mode was added to the test-owned Windows Forms fixture: WS_EX_NOACTIVATE, ShowWithoutActivation, an off-screen manual position, no taskbar entry, and a bounded lifetime plus file-based graceful stop. The original foreground-taking fixture behavior remains available only under the existing explicit interactive acceptance switch.

A new Windows-only candidate acceptance test performs a real process.run -> desktop.snapshot -> desktop.act(select) flow against a locally owned WinForms ListBox. It checks trusted ownership and all of the following:
- initial managed SelectedItem = Background Alpha, SelectedIndex = 0, focused = false;
- final managed SelectedItem = Background Beta, SelectedIndex = 1, and exactly one new SelectedIndexChanged event;
- provider reported verified = true;
- foreground HWND, physical cursor position, and global clipboard sequence were unchanged both on fixture creation and after selection;
- the fixture process exited after its test-owned stop signal (zero remaining matching background fixture processes).

The UIA native notification path now requires the WinForms listbox and its UIA parent window to belong to the same process before sending WM_COMMAND/LBN_SELCHANGE; unsupported classes remain explicitly unverified. Success in a particular WinForms fixture must not be interpreted as universal app-level verification for unrelated list-control classes.

Fresh verification after the candidate acceptance and source guard:
- cargo fmt --all -- --check: PASS
- cargo clippy --workspace --all-targets -- -D warnings: PASS
- cargo test --workspace: PASS
- pnpm -r build: PASS
- pnpm -r typecheck: PASS
- pnpm -r test: PASS (e2e: 31 total, 30 pass, 1 intentionally skipped interactive desktop acceptance)
- PowerShell fixture parser: PASS
- Authored Rust unsafe scan: no unsafe blocks
- git diff --check: PASS
- Targeted background acceptance: 1 pass, 0 fail, 0 skip

This closes the selection-notification app-state regression acceptance blocker for the controlled background-only WinForms fixture. The legacy foreground human-coexistence scenario remains an explicitly separate operator-observed gate, not a claimed pass. No installation, release, or production deployment is authorized by this test.

## 2026-10-17 Phase 1 integration review and fixture correction

The continuation recovered the clean linked worktree at `5734466` on Leno and
preserved the unrelated dirty primary checkout and the installed agent. Independent
native and security reviews found one reproducible fixture defect: Windows
PowerShell uses .NET Framework, where `Environment.TickCount64` is unavailable.
The normal stop-file path masked a broken lifetime fallback.

The new `windows-desktop-fixture-lifetime.test.ts` launches only an off-screen,
non-activating test-owned fixture, omits a stop signal, and requires successful
bounded exit plus a ready, unfocused state. It failed after twelve seconds on the
original fixture. Replacing the unsupported clock with
`System.Diagnostics.Stopwatch.ElapsedMilliseconds` made it pass. The native UIA
implementation is unchanged by this continuation.

Integration scope must remain explicit: at `5734466`, the branch is 22 commits
and 88 files ahead of `main` (`5feee08`), while the UIA patch itself is five files
against parent `1f8e220`. A PR into `main` includes inherited authentication,
relay, and onboarding changes. The narrow UIA reviews do not approve that entire
stack. Ancestor PR #14 is a draft with no submitted reviews at inspection time.

Exact-SHA push CI run `39021633140` passed on Windows and Ubuntu. Hosted Windows
skipped both UIA runtime acceptance tests; real Chromium OAuth was skipped on
both platforms. These omissions remain explicit even when CI is green. No kit
artifact was built for `5734466`; older kit evidence does not identify this
candidate.

Fresh local continuation evidence after the fixture fix:
- Rust format, workspace Clippy and workspace tests: PASS.
- Whole-workspace TypeScript typecheck/build: PASS; the new E2E file also passed
  its final standalone typecheck.
- All non-E2E Node packages: 376 passed, zero failed/skipped, including the real
  isolated Chromium OAuth flow (130/130 relay tests).
- Safe E2E selection: 29 passed, zero failed/skipped. The selection acceptance
  observed `Background Alpha` -> `Background Beta`, one managed event,
  `verified=true`, unchanged foreground/cursor/clipboard metadata, and fixture
  exit. This selection excludes the three operator-observed files named below.
- Lifetime regression: original fixture failed at the twelve-second deadline;
  corrected fixture exited successfully without a stop signal.
- Fixture parser, authored unsafe scan and diff hygiene: PASS.
- Local onboarding Pester: 45 passed / 2 failed, zero skipped. The two named
  failures (`runs device.status and denies process.run through the built tetherd`
  and `passes each generated argument intact and never starts a duplicate agent`)
  require a release binary missing from this worktree. A release build was
  attempted, but Windows Code Integrity events 3033/3077 blocked
  `thiserror_impl-0e1245d5a4bc340c.dll`; Rust reported E0463. No policy was changed
  or bypassed. The local release/Pester gate remains blocked; old CI cannot
  replace final-head verification.

## Inherited-stack review and availability corrections

The main-target integration review inspected all 30 inventoried inherited
production/configuration files and confirmed two P2 availability findings:
abandoned browser CSRF proofs were retained without a bound, and the provider's
registration route aliases bypassed the exact-path registration throttle.
`docs/superpowers/plans/2026-10-17-inherited-auth-resource-bounds.md` records the
implementation plan, RED/GREEN evidence and review decisions.

The correction caps active form proofs at 1,024, prunes expired proofs before
issuance, preserves existing live proofs and UID refresh, and rejects additional
forms with 503/Retry-After. `/REG`, `/reg/` and `/ReG/` now share the canonical
registration budget. Real HTTP and real OIDC-provider/SQLite tests failed before
the correction and passed afterward. A focused independent completion review
found no concrete blocker. Identity, scopes, account/device bindings, grants,
local policy and deployment configuration were not changed.

Fresh final local gates: Rust format/Clippy and 138 workspace tests PASS;
whole-workspace TypeScript typecheck/build PASS; 378 non-E2E Node tests PASS
(auth 82/82, relay 130/130 including real isolated Chromium); safe E2E 29/29 PASS
including background UIA managed state, one event, preserved human metadata and
fixture exit; unsafe scan/diff hygiene PASS. Zero failures/skips in these
selections. Three operator-observed E2E files remain deferred. The local
release/Pester gate is still blocked by the Code Integrity denial described above.
Both PR and push CI passed on Windows/Ubuntu for preceding `b130db9`; this does
not predeclare CI for the subsequent auth correction.

The inherited review's four disclosed Minor release findings remain: power-loss
durability/fsync, exact existing-task adoption/restart verification, premature
pairing-code cache expiry, and the optional doctor's device-identity correlation.
The review did not certify physical lifecycle, scheduler deployment or production.

## Phase 2 operator-observed acceptance plan — not started

Use Leno only, the final reviewed SHA, and a separate candidate Compact MCP
runtime. Keep the installed agent, local policy, existing browser profile,
production relay, OAuth configuration, and other devices unchanged.

Before execution, obtain both operator availability and explicit scoped approval
for a short fixture-only foreground window. Record the approved duration, the
candidate SHA, the two test-created fixture windows, permitted setup activation
and test-fixture cleanup, and read-only coexistence observations. The current
legacy test reads clipboard text locally to compare digests; that observation
must be included in the scope, with no clipboard contents retained in logs.
Setting `TETHERPLANE_INTERACTIVE_DESKTOP_ACCEPTANCE=1` is an opt-in test switch,
not local-agent approval or a foreground lease. An AI caller must not self-issue
a lease or bypass a local denial through another execution route.

After the local scope is approved, run only the legacy
`tests/e2e/desktop-coexistence.test.ts` in an isolated process with that opt-in
switch, bounded by the approved window. Its setup activates the test-created
owned and external fixtures; permission must cover both. During the semantic
operations, `background_only` and all ownership denials still apply. No physical
pointer move or OS keyboard injection is needed; invalid-lease requests must
remain denied.

1. In an awake, untouched interval, check each `set_value`, `invoke`, and `select`
   trace. Require exact managed selection `Owned Beta`, preserved foreground
   window, cursor and clipboard, and denied mutation of the external fixture.
2. In a separate operator-active interval, confirm the operator retains control
   while only owned fixture state changes. Do not relabel operator movement as
   an automation failure or relax the untouched-interval assertions. The existing
   strict cursor-equality test is the untouched proof; the active interval needs
   a separately recorded operator observation, not a claimed pass of that test.
3. Require private clipboard isolation, invalid-lease denial, denial of
   caller-issued foreground authority, and closure of all test-created fixtures.
   Recheck the original human workspace and existing agent. Log only bounded
   metadata and outcome categories, never user text or credentials.
4. Stop on a local denial, scope expiry, loss of operator availability, unexpected
   activation, or an ownership mismatch. Report the exact operation and evidence;
   do not retry through a less restrictive tool. On interruption, close only
   revalidated test-owned resources within the approved cleanup scope.

Browser coexistence and foreground-probe files also remain deferred until the
operator window and their observation scope are approved. Capture their results
separately. Integration still needs final-head CI and review of the inherited
stack; release/deployment additionally needs its own candidate-kit and clean-device
lifecycle evidence and explicit authorization. No merge or production action is
performed by this plan.

## Prepared operator-active concurrent acceptance — 2026-10-17

Status: **test harness prepared; NOT EXECUTED in operator-active mode**. The
previous scoped foreground window expired; this preparation creates no new
authorization and does not modify the installed Leno agent, production or
human-owned applications.

Implementation: `tests/e2e/windows-operator-concurrent.test.ts` is skipped
unless both `TETHERPLANE_INTERACTIVE_DESKTOP_ACCEPTANCE=1` and
`TETHERPLANE_OPERATOR_ACTIVE_ACCEPTANCE=1` are supplied along with a
matching full `TETHERPLANE_APPROVED_CANDIDATE_SHA` and a future
`TETHERPLANE_OPERATOR_APPROVAL_DEADLINE` within the next 15 minutes,
with at least 90 seconds remaining. **These variables only guard the test:
they are not a foreground lease or evidence of human approval.** Obtain new,
explicit scoped consent and verify operator availability before setting them
or running the live case. Never bypass a local policy denial.

The helper `tests/e2e/fixtures/windows-operator-activity-probe.ps1` uses only
read-only Win32 APIs (`GetCursorPos`, `GetLastInputInfo`,
`GetForegroundWindow`, `GetWindowThreadProcessId`, and
`GetClipboardSequenceNumber`). Its adjustable 20–50-ms sampler records only aggregate
cursor-motion counts, input-tick change counts, clipboard-change counts,
whether the test-owned fixture ever became foreground, elapsed time and phase
sample counts. No keystrokes, clipboard contents, raw cursor coordinates,
window titles, process handles or unredacted input times are stored in output.

A candidate Compact MCP process owns only one off-screen, non-activating
WinForms fixture with a 30-second lifetime fallback. The probe is also
limited to 30 seconds. It requires operator movement during an initial
baseline, acknowledges `set_value`, `invoke`, and `select` phase markers
before each candidate semantic call, and closes the phase immediately when
the RPC returns. It checks managed text, invoke status, exact `Beta`
selection, one selection event, zero fixture focus/foreground samples and
zero clipboard changes. Human cursor motion is *expected* during a genuine
operator-active interval; the untouched-desktop equality assertions remain
in their separate existing test.

The runner signals two test-owned stop files, awaits the observer's exit
and the fixture process's exit, and removes temporary state **only once both
processes have exited**. If MCP or fixture cleanup fails, the stop signals
remain available for the bounded fallback, and no unrelated process may be
terminated. A missing overlap of input events and semantic actions is
**inconclusive/failing**, never silently certified.

Preparation verification must include RED→GREEN for the sampler and approval
guard, E2E typecheck, ordinary test suite with this test skipped, and the
complete repository gates. No live concurrent result, production rollout,
PR merge or release authorization is implied by passing those tests.

## Concurrent-test preparation verification and scheduling diagnosis

The read-only sampler and approval/interlock logic were developed with
observed RED→GREEN tests. The operator-overlap threshold requires at least
three cursor-motion samples and three input-tick changes in **one**
acknowledged semantic-action phase; distributing one late sample across
three phases cannot pass. Live 20-ms probe polling is bounded and records
only aggregate counts. The candidate is locked to hostname `Leno`, full
Git SHA and a fresh, explicit short-lived operator approval. The hostname
gate also failed first on `Surface`, then passed after correction.

The *standard concurrent* `pnpm -r test` failed twice on Leno in the
pre-existing browser bridge B6 Chromium integration test (download
readiness timeout and 30-second test timeout). The same integration test
passed in isolation (1/1), and the browser package passed independently
(67/67). Full `pnpm -r --workspace-concurrency=1 test` passed including
the new probe test and with the live operator-active case skipped.
A new repository `.npmrc` sets `workspace-concurrency=1` to retain
the same tests/coverage with deterministic cross-package scheduling.
After that setting, ordinary `pnpm -r test` also passed. This avoids
the observed cross-package Chromium startup pressure; it trades faster
parallel package execution for reliable tests and builds.

All live concurrent acceptance remains **NOT RUN**: it must be invoked
only during new explicit scoped approval with operator present. The
operator-active program must not claim a pass based on the sampler's
background dry run or on the prior separate mouse-motion observation.

## Final background-only B8 coexistence root-cause ruling (2026-10-17)

B8's previous endpoint assertion conflated a physical cursor change with an
agent-caused cursor change. The assertion ran against Leno's actively used
human desktop; it could not attribute the movement. This failed on 2026-10-17
with different cursor endpoints, while the candidate semantic operations
and human-page ownership checks were otherwise successful. The new
`background-desktop-observation` helper brackets the test with a read-only
Windows `GetLastInputInfo` OS input tick and classifies a state change
without intervening input as a **violation**. If input occurred and physical
desktop state changed, the test is **inconclusive/skipped**, never passed.
The tick may also advance for synthetic input, so it cannot prove the human
caused the movement. Stable cursor, clipboard and foreground observations
are still required for a verified coexistence result. The B8 browser
fixture remains protected by resource ownership assertions and the test
now surfaces machine-readable `browser.create_tab` errors rather than an
undefined page ID.

Full non-interactive repository gates on the final code tree:
- `cargo fmt --all -- --check`: PASS
- `cargo clippy --workspace --all-targets -- -D warnings`: PASS
- `cargo test --workspace`: PASS
- `pnpm -r build`: PASS
- `pnpm -r typecheck`: PASS
- `pnpm -r test`: PASS (E2E 46 total: 44 pass, 0 fail, 2
  deliberate foreground/operator-active skips; B8 and B6 both passed)
- `python scripts/check-no-unsafe.py`: PASS
- `git diff --check`: PASS
- PowerShell activity-sampler parser: PASS

The final **operator-active simultaneous** test still requires renewed,
scoped approval and an actively participating operator on Leno. Passing
these background-safe gates is not its acceptance or deployment approval.


## 2026-10-17 controlled concurrent-acceptance diagnostic

The user explicitly authorized a 15-minute operator-active acceptance window on
Leno, ending 17:38:41 Dubai time, and confirmed they were at Leno moving
the mouse. The installed agent remained in `background_only`, and only
test-owned, off-screen, non-activating WinForms fixtures were launched.

Observed live attempts (no live acceptance pass claimed):

- The first attempts stopped at the operator-activity baseline: zero sampled
  cursor motion and zero input changes; no semantic action occurred.
- One operator-active attempt passed baseline and `set_value`, then stopped
  at `invoke`: the test wrongly required `outcome.verified === true`.
  Inspection of `agent/providers/desktop/src/windows_uia.rs` showed that
  `execute_invoke` deliberately returns `verified: false` after sending
  a native button message, because transport success alone does not prove
  application-level state reconciliation.
- The concurrent test now preserves the provider's
  `executed_unverified` contract and checks the application-owned
  `status === "invoked"` before continuing. For `set_value` and `select`,
  it still requires verified transport and expected managed state.
- A subsequent attempt observed 28 input-timestamp changes but zero cursor
  movement. Separate input-desktop inspection confirmed the read-only
  observer was in active Windows console session 1 on desktop `Default`
  (matching `OpenInputDesktop`). This does **not** establish what caused
  the missing movement; no simulated input was substituted.
- The final synchronized motion gate again detected no cursor activity
  and launched no fixture. Execution was stopped before the approval window
  expired. Cleanup checks found zero matching test fixture processes/windows.

Fresh post-window background-only regression:
`node --test --test-concurrency=1 windows-uia-selection-background.test.ts`
exited 0 (1 passed / 0 failed). The extended test confirmed that a native
`invoke` returns `verified: false` as designed **and** the controlled
WinForms application reaches managed `status === "invoked"` without focus.
The same run verified `Background Beta` selection, one managed
`SelectedIndexChanged` event, no focus/clipboard/cursor/foreground change,
and test-owned process shutdown.

**Remaining hard gate:** operator cursor-motion evidence must be sustained
during at least one semantic action in the same approved live run. The
post-window background-only verification does not satisfy this live gate.
Do not merge PR #15 or deploy based on these observations alone.


### Browser-bridge startup contention diagnosed during final verification

The first post-acceptance `pnpm -r test` rerun failed in the existing B6
Chromium operational integration after its 30-second test timeout. In that
run, a separate Chromium fallback test took about 33.9 seconds and B6
elapsed about 30.3 seconds: both were scheduled by the browser package's
default parallel Node test-file runner, despite PNPM workspaces being
serialized. Running that exact browser package test set with
`node --test --test-concurrency=1 test/*.test.ts` passed all 67 tests,
0 failures, in 49.4 seconds. To eliminate concurrent Chromium launches
within the package, its `test` script now sets `--test-concurrency=1`.
No Chromium acceptance tests, assertions, or timeouts were removed or
weakened. Passing this single-package comparison is not a substitute for
the final repository-wide verification gate, which must be rerun.

Operator-active UIA acceptance is still unverified because no sustained
cursor motion was observed overlapping an action in a completed run.
Do not substitute the background-only invoke/selection regression or
an input-timestamp change for physical operator co-activity.

## Chat-mode recovery and bounded acceptance attempt — 2026-10-17, 19:35–19:50 Dubai

After Work usage was exhausted, the uncommitted final-head review changes were recovered **in situ** on Leno's isolated `fix/windows-uia-selection-notify-20261017` worktree. Production, installed agents, foreign worktrees and local policy were not changed.

The operator's previously approved 19:35–19:50 Dubai window was used only for test-owned, off-screen WinForms fixtures and a read-only input sampler. No ForegroundLease, foreground activation, clipboard write, synthetic mouse/keyboard input or human-owned window operation was attempted.

- The 19:35 run sampled six physical cursor changes and twenty input-timestamp changes, with zero owned foreground observations and zero clipboard changes. It stopped at a phase acknowledgment issue, before semantic action.
- The diagnostic rerun completed managed `set_value`, `invoke` and `select` state checks, but the original observer captured 0, 1 and 1 samples in RPC intervals lasting 25, 29 and 51 ms. The assertion demanding a sample in *every* action was removed as inconsistent with the planned requirement: **at least one** independently witnessed overlapping RPC. The actual-overlap predicate remains strict and fail-closed.
- The read-only sampler had an effective tick period too slow for short semantic RPCs because every PowerShell iteration serialized JSON. A new focused TDD regression rejected `-SampleIntervalMs 2` before modification (RED), then passed after allowing a 2ms requested interval and publishing aggregate JSON less often, with immediate phase acknowledgments (GREEN). All read-only counters still exclude raw cursor locations, clipboard contents and keystroke values.
- At 19:46 the faster sampler captured 648 observations in approximately 11.4 seconds but **no physical cursor changes or input activity**; the operator-activity precondition failed, so no UIA action was run. This is not evidence of an agent or UIA failure. It does not prove live coexistence.
- Fresh focused evidence: 16/16 relay/access-log/auth media-type tests, 9/9 operator-gate/sampler tests, and 7/7 Pester Windows onboarding security tests. Rust fmt/Clippy/workspace tests also passed. Repository-wide TS gates must be verified separately after all edits.

**Outstanding acceptance:** Actual cursor and input activity must be recorded **inside one genuine semantic RPC** in a new approved, time-bounded operator window. Do not infer completion from the observed baseline activity, background UIA correctness, sampled input without RPC overlap, or CI. The 19:35–19:50 authorization has expired.

The read-only fast sampler is a candidate test-only optimization, not a granted foreground capability. Independent final-head review, clean repository gates, focused commits, GitHub checks and clean-device lifecycle acceptance remain separate.

## Leno operator window — 2026-10-17 21:14:29–21:29:29 Dubai time (not accepted)

The operator confirmed availability for a fresh scoped 15-minute window.
Candidate HEAD was `cadecffedac51021720fc583df55f797b76a304f`.
Only the isolated branch's test-owned, off-screen WinForms fixture and
read-only input sampler were involved. No foreground lease or physical
input simulation was granted or attempted. The installed agent remained
`background_only`.

The controlled attempts failed closed for different reasons:

1. Around 21:15, the activity sampler recorded substantial human motion
   but exited when `ReadAllText` encountered a transient Windows
   phase-marker sharing violation. This was reproduced deterministically
   with a test-owned exclusive file lock (RED) and corrected by retaining
   the prior phase only for an underlying `IOException` (GREEN).
   Invalid phase content and other exceptions remain fatal.
2. Around 21:19, the sampler stayed alive but the Node test runner's
   `writeFile` of the phase marker returned `EBUSY`. A bounded retry
   helper now retries only `EBUSY` (at most 40 attempts, 10 ms apart),
   outside the measured semantic-RPC interval. New deterministic tests
   verified RED before the retry and GREEN afterward; non-sharing errors
   are immediately propagated and persistent contention remains fatal.
3. Around 21:23, a subsequent live attempt collected 648 baseline
   observations but detected zero physical cursor movements or
   input-timestamp changes. It stopped *before* UIA semantic actions.
   This does not establish a session mismatch or provider defect and
   cannot certify concurrent human use.

Fresh code verification on the patched tree: Rust fmt, Clippy and workspace
tests, TypeScript build and typecheck, full `pnpm -r test` (E2E
53 passed / 0 failed / 2 approval-gated skips), unsafe-code scan,
`git diff --check`, and PowerShell parsing all exited successfully.
Test-owned WinForms processes and windows were independently confirmed
at **zero** after the runs. The fixes affect the acceptance harness only;
the local Tetherplane agent and human-owned applications were unchanged.

**Acceptance remains pending.** A new short-lived, explicit operator window
and synchronized physical activity are required. Neither the passing
synthetic lock regressions nor baseline activity outside a verified RPC
can substitute for the live overlap gate. PR #15 must remain draft until
all independent integration and release acceptance requirements are met.
