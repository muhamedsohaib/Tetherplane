# Tetherplane Windows notifications — unpackaged developer beta

Date: 2026-11-03
Disposition: **developer beta / prototype**, not a Windows Store release.
Approved change: do not require a signed MSIX, Store certification, or user validation of a production Windows application.

## Current implemented slice

- Crate: `agent/tether-notifications`. Event policy classifies verified connections, disconnects, pairing requests, approval requirements, revocation and setup issues.
- Notification XML: text-only and escaped; there are **no approval buttons**, navigation actions, or capability grants.
- `show_packaged()` remains reserved for an actual installed `ARCUSLabs.Tetherplane` package and is not a developer-beta prerequisite.
- `show_dev_beta()`, gated behind Cargo feature `dev-beta`, dispatches using the fixed Windows classic desktop AUMID `ARCUSLabs.Tetherplane.DevBeta`. This ID is only presentation metadata; it is **not an authentication principal**.
- `scripts/windows/Register-TetherplaneToastBeta.ps1` offers **per-user only** Register / Status / Unregister operations for a native Start-menu shortcut. Registration is explicit and reversible. It has no startup task, service, credential, network, registry, security-policy or elevated-permission changes. It checks shortcut ownership before any overwrite or removal.
- The diagnostic executable's `--smoke --developer-beta` mode sends only a clearly labeled synthetic test; it cannot claim an authenticated connection or approve any action.
- This beta uses the inbox `Windows.UI.Notifications` API to reuse the existing Rust WinRT dependencies. Microsoft recommends Windows App SDK `AppNotificationManager` for new applications; migration can be evaluated later, without making it a beta prerequisite.

## Development and per-user setup (when Rust compilation is permitted)

From the isolated repo worktree, on a Windows host with an authorized working Rust toolchain:

```powershell
cargo test --offline -p tether-notifications --features dev-beta
cargo clippy --offline -p tether-notifications --features dev-beta --all-targets -- -D warnings
cargo build --offline -p tether-notifications --features dev-beta --bin tetherplane-toast-smoke
# Only for Windows gnullvm developer toolchains: add their libunwind.dll to THIS shell's PATH.
$rustBin = Join-Path (rustc --print sysroot) 'bin'
$env:PATH = "$rustBin;$env:PATH"
$exe = (Resolve-Path .\target\debug\tetherplane-toast-smoke.exe).Path
.\scripts\windows\Register-TetherplaneToastBeta.ps1 -Operation Register -Executable $exe
& $exe --smoke --developer-beta
.\scripts\windows\Register-TetherplaneToastBeta.ps1 -Operation Status
```

When no longer needed, run:

```powershell
.\scripts\windows\Register-TetherplaneToastBeta.ps1 -Operation Unregister
```

Do not run the registration helper if PowerShell execution is restricted by an administrator or system default. Never override execution policy or Windows Code Integrity just for the beta. The helper refuses to replace an existing shortcut it does not own. Do not register the beta shortcut automatically during device pairing, installation, or agent startup.

## Verified evidence on 2026-11-03

1. **Vaulter (Windows):** Rust 1.98.1/gnullvm, offline dependencies, existing rust-lld linker. Developer-beta feature: **12/12 tests passed**; Cargo formatting and strict Clippy passed. It compiles the Windows native adapter.
2. **Leno:** `Get-ExecutionPolicy -List` showed `CurrentUser=RemoteSigned`. The helper registered the dev-beta shortcut with `System.AppUserModel.ID=ARCUSLabs.Tetherplane.DevBeta`, verified the value, and unregistered it. Foreign shortcut overwrite and removal were both denied. Test-created links and scratch executables were cleaned.
3. **Leno Windows notification smoke:** With an ephemeral per-user dev AUMID/shortcut, a synthetic toast was sent using the Windows WinRT API from PowerShell. `ToastNotificationManager.CreateToastNotifier(devId).Show()` returned successfully and `ToastNotificationManager.History.GetHistory(devId)` reported **1** history entry. This verifies the OS notification pathway but **does not** prove the native Rust executable displayed a toast or that the popup was visually observed.
4. **Vaulter PowerShell:** All execution-policy scopes were `Undefined` and `.ps1` execution was blocked in that environment. The policy was **not** overridden.
5. **Leno Code Integrity:** Event 3077 blocked the unsigned Rust `rustc_driver` DLL under its signing policy. The local policy was **not** weakened. Independent Rust gates ran on Vaulter.

## Next developer-beta acceptance gates

- [ ] Actual native `tetherplane-toast-smoke.exe --smoke --developer-beta` dispatch, executed with a legitimately registered AUMID, independently observed on Windows.
- [ ] Trusted local read-only event source from the existing authenticated agent / owner-approval flow, enforcing actual source authentication rather than trusting an `Event.provenance` enum.
- [ ] Multi-source replay/epoch handling, malformed message and cross-user IPC denial tests.
- [ ] Verify notification display and retained history under normal notification settings and non-disruption of human-owned windows.
- [ ] Verify offline, unknown, revocation and reconnect events against real authorized devices, eventually Leno, VAULTER, Surface and RTX.
- [ ] Decide whether to expose consent-preserving 'Review' navigation from a toast; until the trusted owner UI exists, keep toasts non-interactive.

**Do not** merge protected branches, change Windows Code Integrity, modify OAuth/DCR clients, replace an agent, alter existing scheduled tasks, install a product, or claim production readiness from this prototype.

## Standalone runtime boundary — Vaulter, 2026-11-03

- The Vaulter `gnullvm` standalone executable initially failed with status `0xC0000135` (`STATUS_DLL_NOT_FOUND`). PE import inspection identified `libunwind.dll` as a runtime dependency absent from its process PATH.
- The DLL already exists in Vaulter's Rust toolchain under `<rustc sysroot>\bin\libunwind.dll`; no installer, download, code-integrity exception or global PATH change was performed.
- After prepending that **existing toolchain bin directory to the test process PATH only**, the executable launched. `--unexpected-option` returned exit code `2`. `--smoke` without package identity returned exit code `1`, Windows HRESULT `0x80073D54`. Both were the expected fail-closed behaviors.
- Default features independently passed **11/11 tests** and strict Clippy in addition to the developer-beta feature suite's **12/12**. The standalone beta `--smoke --developer-beta` mode has not been verified with a matching Windows shortcut and the compiled Rust executable together.
- A future portable beta build must either bundle its legally redistributable runtime dependencies with verified hashes and licensing or use an appropriately configured MSVC toolchain. Do not distribute the Vaulter debug executable as if it were portable.
