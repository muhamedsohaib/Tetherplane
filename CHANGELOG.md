# Changelog

This document records **released** versions separately from **unreleased/private** candidates. A successful GitHub Actions job or an authenticated connection on one owner device is not evidence that a general Windows installer is safe or ready for distribution.

## Unreleased — Windows private candidate (verified 2026-11-01)

**Status:** Private, owner-tested candidate. **Not tagged, published, signed, or certified as a new release.** A [private GitHub draft release for proposed `v0.1.1-rc.1`](https://github.com/muhamedsohaib/Tetherplane/releases/tag/untagged-350718c4ebaa0c7c519a) exists (**draft ID `430562213`, unpublished, no Git tag or attached binary**). Both installed agents still report `0.1.0`; the source changes are on draft [PR #119](https://github.com/muhamedsohaib/Tetherplane/pull/119), which is not merged. See the [complete draft release notes](docs/release/v0.1.1-rc.1.DRAFT.md).

### Fixed — actual Windows desktop evidence

- The ordinary non-PTY `process.run` path now applies Windows `CREATE_NO_WINDOW`. Redirecting stdin/stdout/stderr alone previously permitted visibly flashing PowerShell consoles. This is a targeted fix; it does **not** claim that deliberate PTY or user-owned terminals are hidden.
- An automated Windows regression test starts PowerShell and checks its own `GetConsoleWindow()` value, rather than inferring invisibility from a successful command.
- On authorized Leno, after a rollback-protected handover, the private GUI-subsystem agent completed the same no-console test: output `NO_CONSOLE_WINDOW`, exit code `0`. The device remained authenticated in `background_only` policy mode.

### Verified — reproducible evidence

- **Source:** `d327117217c69e177019a6d6361c93870e579d79` (isolated hotfix branch based on the private Windows candidate; not the published `v0.1.0` tag).
- **Private Windows build and regression gate:** [GitHub Actions #41281507337](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41281507337) — succeeded and produced a binary SHA-256 of `411e0f07f32ca3e6cf69a5ca53f3995e268946df419600bf0c807d737d00895c`.
- **Broader CI:** [GitHub Actions #41281511821](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41281511821) — Windows quality, Ubuntu quality, and release-policy checks succeeded.
- **Leno real-device post-migration:** one `tetherd-agentw.exe` process from `TetherplanePrivateNoConsole-20261101`; authenticated `device.status` returned ready; no visible top-level agent window; previous task disabled and retained for rollback.
- **Surface private recovery (2026-11-01):** corrected the relay WebSocket port from `10000` to `443` without changing device credentials or scopes; imported a separately staged GUI-subsystem agent. Authenticated Surface `device.status` returned **ready** and `background_only`; exactly one agent had an established port-443 socket; a live non-PTY PowerShell check returned `NO_CONSOLE_WINDOW`, exit `0`, and restricted `device.help` returned `permission_denied`. Obsolete auto-rollback was disabled after a local XML backup. **Actual restart/logon acceptance remains untested.** See [Surface private recovery acceptance](docs/release/SURFACE_PRIVATE_PORT443_ACCEPTANCE_20261101.md).
- **Owner acceptance record:** stored locally under `%LOCALAPPDATA%\TetherplanePrivateTrial\20261101\`. Local verification is not equivalent to independent multi-device acceptance.
- **Documentation and policy CI:** [Actions #41303340362](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41303340362) finished successfully on an earlier documentation commit, including Windows quality, Ubuntu quality and release policy; subsequent documentation commits must be evaluated separately.
- **Chronological evidence and exact release state:** [2026-11-01 Windows recovery log](docs/operations/2026-11-01-windows-private-recovery-log.md) and [machine-readable candidate manifest](docs/release/windows-private-candidate-20261101.json).

### Operational changes on the owner test machine — NOT distributable behavior

- Disabled the redundant legacy PowerShell browser startup task and its HKCU Run entry after backing up their definitions.
- Did **not** bypass Windows Application Control: the unsigned native browser launcher was blocked with OS error `4551`, so browser autostart was left disabled.
- **Security policy clarification from read-only Windows checks (2026-11-01):** The private `tetherd-agentw.exe` is **NotSigned** on both devices. Surface runs **Windows 10 build 19045**, which does **not** offer Smart App Control; it did enforce PowerShell script signing and the owner did not weaken that policy. Leno runs **Windows 11 build 26300**, but its Smart App Control On/Evaluation/Off mode was **not independently established**. Successful execution under existing restrictions is not a universal Windows 11 Smart App Control or trust certification. [Microsoft reference](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app).
- Preserved existing OAuth/device identity, credentials, policy grants, original binaries, and rollback snapshot. Did not restart Windows or close unrelated terminals.

### Known gaps / release blockers

- Browser provider remains unavailable on Leno. Browser extension enrollment/active profile and trusted native browser launcher require separate authorized acceptance.
- Tailscale reported an offline `NoState` backend and historical service crashes; its root cause and repair are unverified.
- No clean-machine installer trial, reliable reboot/logon/sleep/wake recovery trial, four-device authenticated acceptance, verified unauthorized-denial matrix, or distributable signing/trust validation exists for this candidate.
- The repository lacks approved bundled official logo/icon assets. The owner has now supplied **four approved monochrome source images**, with original SHA-256 values recorded in [the branding gate](docs/branding/ICON_DISTRIBUTION_GATE.md). Derived icon assets are prepared but are **not yet embedded in the repository or installed plugin**; packaging and host-display acceptance remain outstanding.
- Cross-host icon presentation cannot be guaranteed for clients that hide or do not implement icons.

**Release decision:** **NO-GO for general availability.** Proposed `v0.1.1-rc.1` exists **only as a private GitHub draft release**. Version bump, signed distribution, protected merge, tagging and publishing require the outstanding acceptance gates and explicit owner approval. Do not retroactively attach these unreleased changes to the old `v0.1.0` release.

## [v0.1.0] — 2026-09-26

The already-published first GitHub version covered the initial six-tool MCP surface, remote WSS/provider fixes, Windows background-agent supervision, browser coexistence work, and the live-acceptance procedure. For the historical list of changes, use the immutable [v0.1.0 GitHub Release](https://github.com/muhamedsohaib/Tetherplane/releases/tag/v0.1.0) and [tagged source](https://github.com/muhamedsohaib/Tetherplane/tree/v0.1.0).

---
Source of truth for the private Windows candidate: [docs/release/WINDOWS_PRIVATE_ACCEPTANCE_20261101.md](docs/release/WINDOWS_PRIVATE_ACCEPTANCE_20261101.md).
