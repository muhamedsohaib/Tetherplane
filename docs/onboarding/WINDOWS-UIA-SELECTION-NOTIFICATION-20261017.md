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
