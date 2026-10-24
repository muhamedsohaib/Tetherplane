# Owner per-device authority × browser-independent Windows startup — integration checkpoint

**Date:** 2026-10-24. **Draft code only; do not install, enable enforcement, modify OAuth/DCR, merge, sign or release.**

## Exact source lineage
- Parent: [owner-managed per-device authority PR #50](https://github.com/muhamedsohaib/Tetherplane/pull/50), head `ac074f181a5555f461ad5d0e170b19f92ee5a052`, itself stacked on the exact Control Center + Windows onboarding integration PR #49.
- Imported: [Leno browser-independent core startup PR #56](https://github.com/muhamedsohaib/Tetherplane/pull/56), head `30783018cb3af1f4888769224525624864363025`, stacked on native-task reliability PR #44.
- Before import, the PR #50 head and PR #56's base `e7ba707a9354167bd0013f1c8dc4065d1244d5fd` had **identical Git blob SHA** for all five updated source/test paths. The sixth imported path was a new standalone release note absent on both baselines. The six exact PR #56 file blobs were transplanted without rewriting, cherry-picking unrelated history, or changing any PR #50 authority files.
- This branch does **not** merge either protected branch, change relay identity/credential/OAuth configuration, or modify live machines.

## Operational and security boundaries
- Owner-managed grants remain **staged only** until the separately authenticated, explicitly configured Control Center owner identity enables enforcement with the exact confirmation phrase.
- Grant key: exact paired device ID and pairing timestamp plus the authenticated OAuth client ID and remote principal ID, scoped to its account. Unconfigured identities must be denied when enforcement is active.
- The grant presets are `blocked`, `observe`, `operate`, with typed owner confirmation, compare-and-swap revision and CSRF. `operate` remains subordinate to local agent policy. No new OAuth clients, scope expansion, permission wildcard or automatic grant.
- Security review of inherited PR #50 found that default `operate` included unrestricted `process.run` and `process.input`; those can bypass capability-specific process controls and filesystem-root restrictions. This integration draft **excludes both** from the broad preset and adds direct/batch deny regressions. A separate shell permission, if ever provided, requires a separately reviewed explicit owner grant and safe execution boundary. No live agent policy changes.
- A missing/unauthorized local browser extension must not prevent `tetherd` from connecting the independently scoped device core. `device.capabilities` rediscovers browser availability by bounded authenticated local handshake; browser invocation still checks the token and local policy.
- No queued or timed-out mutation is replayed automatically. The existing six Compact MCP tools and four-device topology are unchanged.

## Independent evidence and remaining release gates
- The source PR #50 head had passing Windows and Ubuntu **push CI** (run `39978467785`) and portal tests (PR run `39978472759`), but the PR-triggered full Windows quality job was **cancelled** (run `39978472770`). Do not claim that cancelled job passed.
- The source PR #56 head had both Windows and Ubuntu **push and PR full quality passes** (runs `40085986706` and `40085989450`) and Windows-native-task plus both OS WebSocket heartbeat passes (run `40085989456`).
- **This newly combined commit needs independent exact-head CI.** Source PR results do not establish integrated correctness or live-machine acceptance.
- Latest read-only connector snapshot: Leno, Surface, VAULTER responsive with agent `0.1.0`; RTX disconnected/uninitialized; on Surface browser provider unavailable, on Leno authenticated browser provider available. This is not a signed build-origin verification.
- Release blockers: independently reviewed exact combined code, all relevant Windows/Ubuntu CI, stable authorized owner login, explicitly owner-approved identity grant staging, protected `blocked/observe/operate` synthetic and real-device denial/allow checks, documented core startup with browser offline and recovery after pairing without restart, trusted signing, clean-install/reboot, state-preserving rollback, real RTX onboarding when authorized, and four-device acceptance.

**Decision: PRODUCTION NO-GO.** Preserve all current registered OAuth/DCR identities, device credentials, owner browser sessions, authorized pairing boundaries, rollback tasks and protected branches.
