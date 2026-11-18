# Hydrogen / Antigravity — Tetherplane G4 repair ownership

**Owner:** Hydrogen (Antigravity Remote Agent). **Created:** 2026-11-18 UTC. **Status:** needs investigation, not accepted.
**Repository:** `muhamedsohaib/Tetherplane`
**Work branch:** `fix/g4-wpf-fixture-startup-20261118` — Draft PR [#153](https://github.com/muhamedsohaib/Tetherplane/pull/153), targeting `experiment/g4-sandbox-kit-20261118`, **not** `main`.
**Last tested source commit:** `a0521e3472b9b38fd6482030ac458bc44453a348`.
**Initial source kit:** `29af7f1d93e4623c6c6b35b041d3b827d33e4a84`.
**Last known Windows CI G4 portable-kit run:** [44387428709](https://github.com/muhamedsohaib/Tetherplane/actions/runs/44387428709), PASS for noninteractive checks. This does not certify G4.
**Last artifact:** ID `14467371918`, SHA-256 `a2c65eb357a0161e3d59e0f8c29d1367ac33e50e4839124a3f384b5a142ca778`, source `a0521e3472b9b38fd6482030ac458bc44453a348`.

## Goal

Take over Tetherplane's *isolated* Windows G4 desktop-coexistence diagnosis, repair, packaging, and verification. Minimize repeated manual copy/paste. Make the test reliably prove what it asserts while keeping the authorization and production device boundaries intact. Fix the underlying defect(s), not just the test output.

## Most recent independently collected Windows Sandbox evidence (2026-11-18, Surface host)

The kit was launched successfully from Surface's **authorized process** interface using:
- Host staging: `C:\Users\Sohaib\TetherplaneWorkspace\G4-AutoHarness\G4-a0521e34`
- Sandbox config: `G4-a0521e34.wsb`, networking disabled, clipboard redirection disabled, mapped kit read-only, report folder writable.
- Raw TAP evidence: `C:\Users\Sohaib\TetherplaneWorkspace\G4-AutoHarness\G4-a0521e34\reports\G4-Result-a0521e34.txt`
- Done marker: `C:\Users\Sohaib\TetherplaneWorkspace\G4-AutoHarness\G4-a0521e34\reports\G4-Result-a0521e34.done`
- Disposable guest: `5C4D6619-AC42-4`, `WDAGUtilityAccount`.
- Result: **3 tests, 1 pass, 2 failures, 0 skipped**, total duration ~169.2 s; `G4_LOCAL_COMPACT_MCP_EXIT=1`.
- Teardown independently reported `G4_FIXTURE_TEARDOWN=PASS count=0`.

### Test 1 — PASS
`Windows Compact MCP launches nonvisible WinForms and WPF fixture constructors`. Both WinForms and WPF constructor preflight passed through Compact MCP; duration 33044 ms. The earlier WPF constructor/readiness issue is resolved: WPF fixture reached `stage=content-rendered` and published its `owned.json`/human state in the latest interactive test.

### Test 2 — FAIL, cursor moved unexpectedly
`Windows WinForms desktop coexists with a human window through Compact MCP`.
WinForms semantic actions produced verified owned state:
`{text:"owned-semantic-value", status:"invoked", selected:"Owned Beta", focused:false}`.
Human fixture remained focused and unchanged:
`{text:"Human-initial", status:"idle", selected:"Human Alpha", focused:true}`.
`desktop.act(select)` on owned `Owned Beta` returned `verified:true`.
**Strict physical cursor assertion failed:** before `(722,443)`, afterward `(1439,445)`. Do NOT relax/remove this assertion or assume the provider caused it without per-action and idle control evidence. Investigate whether cursor movement occurs independently of semantic actions, during fixture creation/host interaction, or during a specific provider transport. Preserve no-pointer/no-foreground guarantees.

### Test 3 — FAIL, WPF semantic action error
`Windows WPF desktop coexists with an unfocused owned window and human window through Compact MCP`.
Owned WPF state was ready at `stage=content-rendered`:
`{text:"Owned-initial", status:"idle", selected:"Owned Alpha", focused:false}`.
Human WPF state was ready:
`{text:"Human-initial", status:"idle", selected:"Human Alpha", focused:true}`.
First `desktop.act(set_value)` response had `isError=true`; the test failed asserting `isError===undefined` **before logging the structured error body**. Treat exact error code as UNKNOWN. The input text remained unchanged. Instrument `structured(valueResult)` to capture the exact tool error and inspect the WPF UIA backend/planner. Do NOT infer or bypass the authorization failure.

## Code locations

- `tests/e2e/desktop-coexistence.test.ts`: source test, `waitForState`, `runDesktopCoexistenceTest`, `cursorPosition`, action assertions, cleanup.
- `tests/e2e/fixtures/windows-desktop-fixture.ps1`: WinForms/WPF fixture and startup state JSON, typed WPF constructors, cooperative stop.
- `agent/providers/desktop/src/windows_uia.rs`: `execute_semantic_action`, `dispatch_planned_action`, `execute_uia_value_pattern`, `execute_uia_select_pattern`, background UIA handling.
- `agent/providers/desktop/src/windows_compat.rs`: `plan_set_value`, `plan_select`, `ensure_background_uia_eligible`, focus preservation.
- `.github/workflows/g4-sandbox-offline-kit.yml`: portable kit CI + native binary and noninteractive constructor checks.

An attempt to patch extra diagnostics during the preceding chat **was not committed** (the tool operation aborted on a non-unique text replacement). No other diagnostic commit should be assumed after `a0521e...`.

## Hydrogen execution plan

1. Fetch the live branch and latest PR state before edits; work in a fresh isolated worktree. Preserve all other worktrees and active OAuth/DCR changes on Leno.
2. Add **read-only diagnostics**, preserving asserts: full structured `desktop.act(set_value)` error response in WPF; physical cursor position before actions, after each action and in an idle-control interval; fixture stdout/stderr; foreground PID; timestamps; native vs UIA action transport. Add bounded timeouts and error-stage reporting. Never change human-owned resources outside guest.
3. Prove the root cause of WPF action error from the actual MCP response and provider implementation before adjusting backend semantics. Verify it cannot grant foreground authority or silently fall back to pointer/keyboard injection.
4. Reproduce cursor change with a control condition (no action) and action-specific measurements. Fix the smallest verified cause; never mask it with relaxed tolerances, test skips, or rewriting mouse location.
5. CI: run Windows nonvisible constructor preflight, Rust + TS builds, local Compact MCP tests, and negative authorization tests. Confirm the guest ZIP's exact source SHA256. CI alone is **not** interactive G4 acceptance.
6. Build a fresh guest kit on the isolated branch. Run it only in disposable Windows Sandbox, networking disabled and host clipboard sharing disabled. Close an existing Sandbox instance only through authorized owner action; do not force terminate or circumvent `desktop.snapshot` permission denial.
7. Collect TAP + teardown to the mapped report directory automatically. Require **3/3 tests passing, 0 failures, 0 stale fixture processes** in a fresh guest. Re-run once if legitimate startup flakiness is suspected and report both attempts. Distinguish isolated/local G4 from full remote-relay G4.
8. Once isolated G4 passes, prepare next full remote G4 staging acceptance and physical G6 iPhone/Android acceptance plan, without claiming release readiness.

## Hard security/release boundaries

- Do not change production Leno, CUCK, Surface, RTX or VAULTER agents or identity settings, and do not alter the protected four-device authentication architecture.
- Surface is merely the **host** for disposable Windows Sandbox; do not run desktop-control tests against the host's personal windows.
- Surface's connected Tetherplane principal `operator:sohaib` was explicitly denied `desktop.snapshot`. Honor that denial; allowed `process.run` is **not** an authorization to bypass desktop-control scopes.
- No new OAuth clients, altered scopes, browser tab grants, unreviewed credentials, agent restarts, production permissions, force-killing the Sandbox, merges, or deployments.
- PR #153 remains **Draft**; no merge/release without separate owner authorization and full acceptance evidence.
- A genuine authorization denial or unknown action result must not be retried with alternative tools to evade policy.
- Any tool call side effect must be scoped to test-owned disposable files/processes. Preserve human cursor/clipboard/window state.

## Deliverable / required status report

Submit a reviewable isolated-branch commit/PR with reproducible tests, exact source/artifact hashes, the identified root causes (not guesses), before/after interactive TAP and teardown evidence, explicit denial checks, remaining failures and next safe release gate. Never report PASS unless observed on the correct guest and commit.

**Handoff rule:** Hydrogen is to execute the full workstream rather than ask the owner to paste long PowerShell instructions. If remote interactive execution is outside its authorized tool scope, produce only the one unavoidable human action and let a connected authorized assistant collect the report. Do not promise background execution without an actual running agent.
