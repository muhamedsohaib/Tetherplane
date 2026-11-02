# Windows portable Chromium acceptance — 2026-11-02

Status: review only; no live browser activation and no installer or authentication changes.

## Provenance

- Physical test device: Surface, Windows 10 Pro, non-elevated Desktop Commander.
- Source base: draft PR #123, commit `4240ba8b3e638770082a0c62814924b45c99aa76`.
- Test browser: official Google Chrome for Testing v156.0.8078.80, downloaded from `https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/win64/chrome-win64.zip`.
- Download SHA-256: `16EDB57D6107BF1C48A7C149B8D78B155FE614410093796DD72441FD6640540F`.
- The archive was extracted only inside an isolated source checkout; no system browser was installed or configured.

## Changes

Two Windows acceptance tests honor an explicitly selected `TETHERPLANE_CHROMIUM` executable before falling back to the preexisting installed-Chrome path. No production/browser backend behavior, profile grants, OAuth, remote debugging privileges or scope boundary changes. Vercel preview deployment is disabled for this review branch.

## Real-machine evidence

Using `TETHERPLANE_CHROMIUM=<isolated test browser> `, the following passed with Node v24.20.0 and pnpm 10.34.5:

1. `pnpm --filter @tetherplane/browser-bridge typecheck`: passed.
2. `node --test --test-concurrency=1 browser/bridge/test/cdp-private-pipe.test.ts browser/bridge/test/cdp-lab-host.smoke.ts`: **3 passed, 0 failed, 1 skipped**. The skipped check is the independent Edge private-pipe denial test because Surface has no Edge.
3. Before/after test: **0** processes from the portable `chrome.exe` path remained.
4. `node --test --test-concurrency=1 browser/bridge/test/cdp-network-origin.test.ts browser/bridge/test/cdp-backend.test.ts`: **15 passed, 0 failed**.
5. The unmodified extension-free lab-host test also passed before the local test harness change.

No human-owned Opera tabs, credentialed profiles or off-origin sites were opened by the test. The lab host is explicitly nonproduction; it restricts access to a disposable localhost fixture.

## What this does not prove

- No live Tetherplane agent has been configured for browser access on Surface.
- The patched Rust heartbeat agent from PR #123 has not been installed on Surface.
- No real owner consent, signed Store install, Smart App Control or clean-device package acceptance has been performed.
- Network fault recovery and stable Funnel ingress are separate release gates.

## Reproduction

Set `TETHERPLANE_CHROMIUM` to an owner-selected, trusted Chromium executable in the test process only. Run the two Node test commands above from an isolated source checkout. Confirm the test browser is closed and no persistent debugger listener survives; never substitute a human-owned browser profile.
