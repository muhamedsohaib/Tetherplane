# Tetherplane developer-beta notification event source — 2026-11-03

**Status:** Isolated branch implementation; runtime consumer and IPC **not implemented**; release **NO-GO**. No user installation, protected merge, auth modification or production agent restart.

## Code source and exact boundaries

- Base: `origin/main` at `fc8590a7e997c01878ca4d85469d6ba8eae23882`.
- Working branch: `feature/windows-toast-notifications-design-20261103`; predecessor commit `7dd5a7fcd6ff35657de43ae9cb28e05bf75f9ab8`.
- Windows beta notification namespace remains `ARCUSLabs.Tetherplane.DevBeta` (presentation identity only, not an authentication identity). Existing reversible registration helper is untouched.
- `agent/tether-notifications/src/lib.rs` gains `LocalStatusUnknown` (local transport loss does **not** prove a remote device is offline) and independent sequence cursors per device/provenance.
- `agent/tether-notifications/src/session_feed.rs` adds a bounded, nonblocking **in-process** event sender using a guard created after an authorized WebSocket upgrade. Guard destruction emits `LocalStatusUnknown`, never `DeviceDisconnected`. Queue full/dropped fails without blocking the agent; a future observer must expire stale state.
- `agent/tetherd/src/relay_ws.rs` contains the feature-gated hook **after** `connect_async(request).await`, so a rejected upgrade cannot produce a connected event. The existing authenticated gateway in `relay/src/devices/ws-gateway.ts` checks the device ID and credential against `DeviceRegistry.authenticateDevice` before allowing the WebSocket upgrade.
- `agent/tetherd/Cargo.toml` adds `developer-beta-notification-feed` as an opt-in compile feature with an optional dependency. Default features remain empty; `main.rs` explicitly passes `notification_sink: None`. The feature is therefore **not yet a live notification delivery mechanism**.
- `Cargo.lock` adds only the notification workspace package and an optional dependency entry for `tetherd`.
- Two gated synthetic Windows/loopback agent tests cover the 101/close and 401 denial cases; **they have not been executed** owing to a missing Windows linker/SDK dependency on Vaulter.

## Verified test evidence

1. **Vaulter**, Windows 10 Pro, Rust 1.98.1, `x86_64-pc-windows-gnullvm`:
   - `cargo test --offline -p tether-notifications --features dev-beta`: **18/18** library tests passed.
   - `cargo clippy --offline -p tether-notifications --features dev-beta --all-targets -- -D warnings`: **passed**.
   - `cargo fmt -p tetherd -- --check` and `cargo fmt -p tether-notifications -- --check`: **passed**.
   - `cargo metadata --offline --no-deps --format-version 1`: enumerates both crates and accepts the manifest.
   - Source SHA-256 matches between Vaulter and Leno for `lib.rs`, `session_feed.rs`, `relay_ws.rs`, and `tetherd/Cargo.toml`; normalized line-ending hashes match for `main.rs` and `Cargo.lock`.
2. **Leno**, Windows 11 Pro Education:
   - `node --test tests/release/windows-notification-event-source.test.mjs`: **4/4 passed**. These are static placement/feature contracts, **not** live agent tests.
   - `git diff --check`: passed.
   - Windows Code Integrity previously blocked the local MSVC Rust compiler's unsigned `rustc_driver` DLL, unchanged.
3. **Full tetherd build attempt on Vaulter:** `cargo test --offline -p tetherd --features developer-beta-notification-feed --bin tetherd -- relay_ws::notification_feed_contract_tests` stopped during the `ring` build-script linking stage, before agent source compilation, because the existing GNU/LLVM linker could not find import libraries `advapi32`, `ole32`, and `oleaut32`. Vaulter has no Windows SDK/Visual Studio import-library installation and only the gnullvm target. This is an **environmental blocker**, not a passing agent test or proof of implementation correctness.

## Rejected approach and safety

A separately attempted native COM shortcut registrar caused `STATUS_HEAP_CORRUPTION (0xC0000374)` in a disposable Vaulter scratch test. **All uncommitted registration-experiment source changes were rolled back** before this event-source implementation. The previously tested manual, per-user PowerShell registration helper remains the only beta registration approach. No elevated access, execution-policy change, Windows Code Integrity change or credential operation was made.

## Remaining gates

- Make the agent feature's in-process sink available to an independently authenticated **read-only per-user IPC** source, with bounded frames, verified Windows security descriptors, cross-user denial, replay/staleness tests and no caller access to agent commands or credentials.
- Review whether a tray process can authenticate the producing agent identity; do not treat a self-reported `Event.provenance` enum or a listening pipe name as proof.
- Confirm that an unpackaged, registered native Rust beta executable actually dispatches a notification and yields an OS history entry; previous WinRT history evidence came from a **PowerShell** synthetic diagnostic, not the Rust CLI.
- Execute the gated 101/401 tests with a supported Windows toolchain or CI and exact source commit, then run controlled real-agent acceptance. Existing 18 unit tests and four source tests cannot substitute for this.
- Keep the 4-device architecture and all OAuth/DCR, Store signing, Windows startup, existing agent tasks, browser permissions and relay policy unchanged.

**Next smallest intervention:** provide a supported build/test lane with the required Windows SDK import libraries, validate the gated 101/401 agent integration tests, then design the read-only IPC ACL without changing existing authentication.
