# Leno owner-authorized Edge reliability gate — 2026-11-06

## Verified owner-profile observations
- Local owner applied the extension-only snapshot preview; installed `extension/dist/background.js` SHA-256 `F585743E8A9B02756C9DB72A55095ABF51E2DF3F5E786C9CAA01F36F952ADFE4`. Production Tetherplane agent was **not** updated.
- Owner test at 2026-11-06T10:49:32Z: one explicitly shared `https://app.lumalabs.ai` tab; `pages` 8ms, `snapshot` 49ms with 95 nodes, `pages` 2ms; `ONE_AUTHORIZED_READ_SEQUENCE_PASS`.
- Owner test at 10:49:33Z: 6/6 concurrent `pages` and `snapshot` cycles passed, max round trip 34ms.
- Independent Leno remote test at 10:51:44Z: one shared tab enumerated, but first snapshot failed (0/6).
- Independent read-only triage at 10:52:48Z: `pages` 8ms, `snapshot` 5020ms `error.code=timeout`. Further no-content `pages` test: shared Luma tab `active=true`, grant approximately 25 minutes remaining. Therefore error is neither missing pairing nor expired owner consent.
- This proves intermittent per-tab Chrome scripting/renderer observation, **not** steady state reliability. Do not accept a combined production cutover solely from an earlier successful burst.

## Independent deadline inversion confirmed in source
The local Windows release branch contains:
- Rust `agent/tetherd/src/main.rs`: `BrowserBridgeConfig.timeout_ms = 2000` for all browser invocations.
- JavaScript `scripts/browser-unified-rpc-host.mjs`: general upstream deadline `3500ms`, list/status `1500ms`.
- Installed extension's read-only snapshot deadline: `5000ms`.
Thus a `snapshot` taking over 2 seconds can fail inside the native agent **before** either the router or the authenticated extension has returned its bounded result.

## New isolated source candidate
- Native Rust `BrowserProvider::execute`: for `browser.snapshot` only, increase the request's native RPC budget to at least `8000ms`; retain `2000ms` for handshake/status/page enumeration.
- Combined router: `snapshotTimeoutMs=6500`, while list/status remain `1500ms` and other operations remain unchanged; return typed `timeout` for upstream deadline rather than reporting the entire provider as absent.
- Tests added: native simulated 900ms snapshot against a 500ms handshake baseline; router deadline selection, typed deadline error, and invalid deadline rejection. Existing owner-grant enforcement, same-tab routing, and CDP fallback restrictions are unchanged.
- This source modification has **not** been installed, pushed, merged or deployed. It also cannot force a frozen Edge renderer to respond.

## Validation results and blockers
- `node --check` passed for router and test JavaScript files.
- `cargo fmt --all --check` passed.
- `git diff --check` passed.
- Local `cargo check --tests -p tether-browser-provider` failed because MSVC `link.exe` and toolchain libraries are absent on Leno. **Rust behavior has NOT been compiled or tested locally.**
- A remote Node test invocation was blocked by the connector safety gate; do **not** record new 17/17 router tests as passing. Previous 15/15 tests passed **before this latest timeout change**, and the new tests require CI.
- There is an old `Tetherplane Combined Browser Rollback OwnerFinal 20261106` scheduled task in Ready state with past trigger 14:10:06 Dubai and empty NextRunTime. It last exited 0. Do not reuse that completed task name, its historical script or its receipt.
- Production agent: Leno authenticated/ready, `browser.status` backend=`cdp`, ownership=`tetherplane_only`, previous agent task Running; authenticated worker host task Running and no combined-router listener on 17660.

## Release critical path
1. Run the source changes in a trusted Windows CI with Rust MSVC toolchain: Rust provider tests and the new 17-case combined router suite.
2. Build a hash-attested private candidate no-console Windows agent from the tested branch. Do not reuse the existing binary with an incompatible deadline.
3. Independently reproduce at least 20 read-only snapshots of an **owner-shared, non-sensitive** real Edge tab over time, including when Edge is not foregrounded. Measure success rate and typed timeout frequency; never log page contents.
4. If intermittent renderer timeouts remain, isolate them with owner-approved minimal injection instrumentation rather than extending deadlines indefinitely.
5. Only after reliable tests, stage a NEW owner-interactive combined-router cutover with a fresh unique task name, a watchdog rollback, and independent remote `browser.pages` + `browser.snapshot` verification. Do not accept based on `browser.status` alone.
6. A separate reboot/sign-in acceptance should confirm both hidden browser services restart and tab grants remain explicitly owner-controlled.

## Safety and boundaries
No credentials, cookies, unauthorized tabs, owner-pinned extension identity, browser privileges, OAuth, principal, agent task, or production router were changed during this investigation. The only edits are in the isolated feature worktree; preserve previous rollback audit and owner backups.
