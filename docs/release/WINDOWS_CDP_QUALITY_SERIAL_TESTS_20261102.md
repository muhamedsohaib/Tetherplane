# Windows quality browser/CDP test isolation — 2026-11-02

**Base:** draft PR #127, `2b0673d2c7f5d2800f3731ca0d0bbca0a4fb5170`.
**Change:** `browser/bridge/package.json` changes the normal test command from `node --test test/*.test.ts` to `node --test --test-concurrency=1 test/*.test.ts`. A preview-deployment exclusion is added for this isolated review branch. There is **no production logic change**.

## Actual failure evidence

The GitHub Windows quality job `125254898311` in run `41438711176` failed at the existing `pnpm -r test` / browser-bridge package test step, not at Rust compilation. Its browser-bridge summary was 101 tests: 97 pass, 2 fail, 2 cancelled. Specifically:
- `cdp-integration.test.ts`: timeout after 60,000 ms while driving a disposable CDP-owned Chrome profile.
- `cdp-network-origin.test.ts`: unexpected `permission_denied` from expired/absent local grant after about 61,824 ms, longer than its 60-second grant lifetime. An origin denial is security-correct when no grant is current; the test expected a faster fixture action.
- `cdp-private-pipe.test.ts`: Chrome private-pipe handshake timeout.
- `operations-integration.test.ts`: timeout after 30,000 ms.

The dedicated CDP Windows lab on the **same head** passed. That job already uses `--test-concurrency=1` for browser-owning tests.

This suggests test-runner contention or timing interference across concurrent browser-owning test files, but causation was **not independently proven**. Do not increase grant TTL, bypass origin checks, disable tests, or change production browser transport to make a test pass.

## Minimal correction and local proof

Serialize **browser-bridge test files** through its package test script so existing `pnpm -r test` quality CI automatically runs the same tests, without changing workflow permissions. Tests within each suite still exercise async behavior, per-action controls and policy denial; their security assertions are unchanged.

On actual Surface Windows 10 Pro:
- Separate branch/worktree `fix/windows-cdp-quality-serial-20261102` based on PR #127; clean portable Chrome-for-Testing executable under the pre-existing disposable `.test-browser` folder. Human-owned Chrome/Edge profiles were not modified.
- `pnpm install --offline --frozen-lockfile --ignore-scripts`: pass.
- `pnpm --filter @tetherplane/browser-bridge typecheck`: pass.
- `TETHERPLANE_CHROMIUM=<preexisting test-only chrome.exe> pnpm --filter @tetherplane/browser-bridge test`: **101 tests; 100 passed, 1 skipped, 0 failed/cancelled; test duration 27.8 seconds; process exit 0**.
- Browser test output retained locally in `%TEMP%\tetherplane_cdp_serial_20261102.log`.

## Required independent acceptance

The exact review-commit GitHub Windows quality job must pass the full `pnpm -r test` and configured Windows release/security jobs; Ubuntu and dedicated browser labs must stay green. If it fails despite serial test execution, collect job logs, classify separately, and repair the smallest proven issue. A local pass is not a release-ready verdict.

**Release remains NO-GO:** no signed Store installation, real-device browser revocation, stable independent public HTTPS/WSS ingress, approved publisher identity, protected merge, or four-device canary acceptance.
