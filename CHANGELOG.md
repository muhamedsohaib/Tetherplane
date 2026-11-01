# Changelog

This document records **released** versions separately from **unreleased/private** candidates. A successful GitHub Actions job or an authenticated connection on one owner device is not evidence that a general Windows installer is safe or ready for distribution.

## Unreleased — Windows private candidate (verified 2026-11-01)

**Status:** Private, owner-tested candidate. **Not tagged, published, signed, or certified as a new release.** Its reported agent version remains `0.1.0`; the source changes are on draft [PR #119](https://github.com/muhamedsohaib/Tetherplane/pull/119), which is not merged.

### Fixed — actual Windows desktop evidence

- The ordinary non-PTY `process.run` path now applies Windows `CREATE_NO_WINDOW`. Redirecting stdin/stdout/stderr alone previously permitted visibly flashing PowerShell consoles. This is a targeted fix; it does **not** claim that deliberate PTY or user-owned terminals are hidden.
- An automated Windows regression test starts PowerShell and checks its own `GetConsoleWindow()` value, rather than inferring invisibility from a successful command.
- On authorized Leno, after a rollback-protected handover, the private GUI-subsystem agent completed the same no-console test: output `NO_CONSOLE_WINDOW`, exit code `0`. The device remained authenticated in `background_only` policy mode.

### Verified — reproducible evidence

- **Source:** `d327117217c69e177019a6d6361c93870e579d79` (isolated hotfix branch based on the private Windows candidate; not the published `v0.1.0` tag).
- **Private Windows build and regression gate:** [GitHub Actions #41281507337](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41281507337) — succeeded and produced a binary SHA-256 of `411e0f07f32ca3e6cf69a5ca53f3995e268946df419600bf0c807d737d00895c`.
- **Broader CI:** [GitHub Actions #41281511821](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41281511821) — Windows quality, Ubuntu quality, and release-policy checks succeeded.
- **Leno real-device post-migration:** one `tetherd-agentw.exe` process from `TetherplanePrivateNoConsole-20261101`; authenticated `device.status` returned ready; no visible top-level agent window; previous task disabled and retained for rollback.
- **Owner acceptance record:** stored locally under `%LOCALAPPDATA%\TetherplanePrivateTrial\20261101\`. Local verification is not equivalent to independent multi-device acceptance.

### Operational changes on the owner test machine — NOT distributable behavior

- Disabled the redundant legacy PowerShell browser startup task and its HKCU Run entry after backing up their definitions.
- Did **not** bypass Windows Application Control: the unsigned native browser launcher was blocked with OS error `4551`, so browser autostart was left disabled.
- Preserved existing OAuth/device identity, credentials, policy grants, original binaries, and rollback snapshot. Did not restart Windows or close unrelated terminals.

### Known gaps / release blockers

- Browser provider remains unavailable on Leno. Browser extension enrollment/active profile and trusted native browser launcher require separate authorized acceptance.
- Tailscale reported an offline `NoState` backend and historical service crashes; its root cause and repair are unverified.
- No clean-machine installer trial, reliable reboot/logon/sleep/wake recovery trial, four-device authenticated acceptance, verified unauthorized-denial matrix, or distributable signing/trust validation exists for this candidate.
- The repository lacks approved bundled official logo/icon assets. The owner-approved crimson-and-black artwork must be recovered **as original bytes**, checked for provenance/geometry, bundled, and validated in the actual plugin and installer. Synthetic placeholder artwork is not an approved substitute.
- Cross-host icon presentation cannot be guaranteed for clients that hide or do not implement icons.

**Release decision:** **NO-GO for general availability.** Propose a separately verified version (for example `v0.1.1`) only after the release gates pass and the owner explicitly authorizes tagging and publishing. Do not retroactively attach these unreleased changes to the old `v0.1.0` release.

## [v0.1.0] — 2026-09-26

The already-published first GitHub version covered the initial six-tool MCP surface, remote WSS/provider fixes, Windows background-agent supervision, browser coexistence work, and the live-acceptance procedure. For the historical list of changes, use the immutable [v0.1.0 GitHub Release](https://github.com/muhamedsohaib/Tetherplane/releases/tag/v0.1.0) and [tagged source](https://github.com/muhamedsohaib/Tetherplane/tree/v0.1.0).

---
Source of truth for the private Windows candidate: [docs/release/WINDOWS_PRIVATE_ACCEPTANCE_20261101.md](docs/release/WINDOWS_PRIVATE_ACCEPTANCE_20261101.md).
