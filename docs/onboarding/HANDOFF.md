# Tetherplane Windows Onboarding — Engineering Continuation and Release Gate

Date: 2026-10-16 (Leno, UAE +04:00)
Branch: `feature/windows-repeatable-onboarding-20261015`
Base: `f81706f` (`fix/relay-unmatched-route-404-20261015`)
Worktree: `C:\Users\Sohaib\source\Tetherplane-onboarding`
Production release decision: **NO-GO**; worktree changes are not a live deployment.

## Boundary and source of truth

Obey:
- `docs/superpowers/specs/2026-09-17-tetherplane-design.md`
- `docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md`
- `docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md`
- `docs/onboarding/PLAN.md`

Keep work isolated to the onboarding worktree; main Leno checkout contains unrelated dirty state. Device selection is Leno ONLY. Use read-only/background-only operation on human resources. Do not change live Vaulter relay/auth/issuer, private OAuth clients, Leno agent, Tailscale, scheduled tasks, credentials, existing device pairing, or production policy before a gated, approved deployment. The new relay-only `device(op="approve_pairing")` operation is implemented/tested locally but not live.

## Sonnet's stopped checkpoint, independently recovered

Sonnet ran Stage-B E2E; its surviving log at `%LOCALAPPDATA%\Temp\stageb-1315Z\workspace-test.log` reports `28 pass / 1 fail` in its last E2E group. The failed test is `tests/e2e/desktop-coexistence.test.ts:284`, a cursor equality assertion: initial `(325,342)`, observed `(488,194)`. There is no instrumentation proving whether human activity or Tetherplane moved the pointer. **Do not rerun this interactive test unattended; do not mark it PASS**. `browser-coexistence.test.ts` and `foreground-probe.test.ts` also observe human desktop state and need isolated operator-observed acceptance. Sonnet inspected fixture process ownership, killed only the proven fixture child PID and left unreadable/unrelated processes intact. The screenshot contained `HTTP 429` from its model provider, not a Tetherplane product failure.

## Verified repairs from the 2026-10-16 takeover

1. **Pending pairing isolation**: existing relay `DeviceRegistry` allowed two pending pairing codes for one device ID, and second approval could replace its first account. Added `relay/test/device-pairing-isolation.test.ts`; watched RED; added per-device pending map with fail-closed duplicate registration, expiry pruning, and recheck at approval. This is an actual previous cross-account overwrite release blocker.
2. **Durable registry write integrity**: simultaneous approvals to different devices collided on the same `.tmp-${pid}` file and failed with `ENOENT`; denied disk writes could still mutate in-memory auth state. Added `relay/test/device-registry-persistence.test.ts`; watched RED; serialized registry mutations, persisted proposed state before publishing successful approvals or revocations, preserved pending code after failed durable approval. Tests cover concurrency and failed approval/revoke persistence.
3. **Kit rebuild ownership**: previous kit builder recursively deleted prior kit directory on manifest marker alone, including unknown or locally modified user files. Added three failing Pester regression tests in `tests/onboarding/windows-onboarding-kit.Tests.ps1`; added guarded inspection of previous kit entries and hashes before replacing.
4. **Headless Chromium test isolation**: the full Node suite's Chromium browser-flow test reused fixed CDP port `19322` and left headless children; two headless test-profile listeners were observed on Leno. Added `relay/test/helpers/chromium-debug-port.ts` and passing unit test `relay/test/chromium-debug-port.test.ts`; updated `relay/test/tether-auth-chromium.test.ts` to request an ephemeral CDP port and read the port from its own temporary profile's `DevToolsActivePort`, with teardown explicitly scoped to its spawned Chrome child tree. Full Chromium flow is **not yet verified** after this change.

## Fresh quality evidence

- Onboarding PowerShell/Pester v3.4 suite: **43 passed / 0 failed / 0 skipped or inconclusive**, `scripts/run-onboarding-tests.ps1` (2026-10-16).
- Relay pairing/security/durable write suite: **21 passed / 0 failed**, plus a separate Chromium debug-port helper test **1 passed / 0 failed**.
- Background-safe E2E selection excluding operator-observed desktop/browser tests: **26 passed / 0 failed** (2026-10-16).
- Rust `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`: **PASS**.
- TypeScript `pnpm -r typecheck`: **PASS** in the final fresh 2026-10-16 run after the Chromium helper change. Relay typecheck separately **PASS**.
- Workspace build `pnpm -r build`: **PASS** after Chromium helper patch.
- Isolated new ephemeral-port headless Chromium full browser-flow test: **1 PASS / 0 fail** on 2026-10-16 (~84 seconds); CDP callback reached and CSP assertions passed. **Post-test process inspection found that the new test's headless Chrome subtree remained present**. Teardown is NOT proven safe/complete. Do not rerun until ownership-scoped cleanup is approved and fixed.
- Full Node suite was successfully run earlier on this branch before the latest Chromium harness change, but fresh rerun hung at `relay/test/tether-auth-chromium.test.ts` (fixed port test). **Do not describe the latest full Node sweep as passing**. Related test runner handle `proc_d555786b4fe04c8c8d873aab61fbd5bc` remains active or must be rechecked; attempt to terminate via the Tetherplane process capability returned `approval_required`. Do not bypass that local policy with an alternate kill method.
- Build and remaining gates: verify fresh command evidence in the current chat/run before asserting.

## Release blockers and next steps

1. Resolve the stuck test-runner AND multiple orphaned headless Chromium test-profile process trees through an appropriate **local-agent approval**; do not terminate unrelated processes. Fix the test cleanup with ownership and leak assertions; then rerun Chromium and complete Node suite. An isolated successful browser-flow callback is insufficient when the test leaks processes.
2. Independently review pairing and persistence changes for restart/replay, cross-process access, brute-force enrollment, rollback behavior and device credential isolation. Ensure no credentials or auth data appear in logs or commits.
3. Run complete cross-platform CI on a pushed feature commit; publish private Windows kit from immutable code. Verify from ZIP + manifest on a **clean** Windows machine using a unique local device credential.
4. Only after gated security review and explicit production approval, deploy relay-only pairing operation to Vaulter with backup/rollback; prove the existing ChatGPT OAuth connection and Leno status were not regressed.
5. Perform actual full new-device pairing, supervised reconnect, reboot recovery, policy denial, upgrade/uninstall and human-coexistence acceptance in an operator-observed window. Do not call product production-ready while any required acceptance is red/unverified.
6. Windows kit presently requires the same Tailscale tailnet as Vaulter, provides unsigned ZIP / SHA-256 integrity but not authentic publisher signing, and does not currently constitute internet-wide one-click onboarding.

No live production installs, credential changes, pairing approvals, relay restarts, or releases were authorized or performed in this takeover. This is a continuation record, not a release authorization.
