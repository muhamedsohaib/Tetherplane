# Private Windows acceptance — Leno, 2026-11-01

> **Release status:** Private owner-only acceptance; **no general release**, no protected merge or tag. This note complements [CHANGELOG.md](../../CHANGELOG.md) and preserves the older published `v0.1.0` history.

## Actual changed path

Baseline private candidate: `48ddc41a6139b766e1f0ebd01e658f00837f6431`. Hotfix source: `d327117217c69e177019a6d6361c93870e579d79` on draft [PR #119](https://github.com/muhamedsohaib/Tetherplane/pull/119).

- `agent/providers/process/src/session.rs`: ordinary non-PTY Windows `process.run` now launches console-subsystem children with `CREATE_NO_WINDOW`, rather than relying on stdio redirection to hide them.
- Windows regression test uses PowerShell and Win32 `GetConsoleWindow()`, checking absence of a console. It covers the piped, non-PTY path only.
- No change to authorization grants, OAuth/DCR, device identity, relay protocol, browser permission checks, or the four-device architecture.

## Reproducible build / checks

| Evidence | Result | Scope |
| --- | --- | --- |
| [Private hotfix build #41281507337](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41281507337) | PASS | Windows native compilation, GUI PE-subsystem validation, no-console regression, artifact SHA-256 provenance |
| [Windows/Ubuntu CI #41281511821](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41281511821) | PASS | Windows quality, Ubuntu quality, release-policy jobs |
| Leno actual GUI task | PASS | New `tetherd-agentw.exe` started with unchanged existing authorized credentials and owner task principal |
| Leno `device.status` | PASS | Authenticated `ready`, policy `background_only` |
| Leno `process.run` non-PTY no-console test | PASS | `GetConsoleWindow() == 0`, output `NO_CONSOLE_WINDOW`, exit `0` |
| Leno process inventory | PASS | Exactly one `tetherd-agentw.exe` from `TetherplanePrivateNoConsole-20261101` |
| Rollback restoration | PREPARED, NOT EXERCISED ON THIS HOTFIX | Original task, binary and independent scheduler snapshot preserved; timed recovery controller successfully probed |

**Exact installed binary SHA-256:**
`411e0f07f32ca3e6cf69a5ca53f3995e268946df419600bf0c807d737d00895c`.

An isolated one-time post-change observation reported about 8.8 MiB of agent working set. **Do not claim a memory-performance improvement** from this uncontrolled sample; older snapshots were taken at different times and load conditions.

## Owner-machine actions

- The original `Tetherplane Private Agent 20261101` task was disabled and retained.
- The current `Tetherplane Private Agent NoConsole 20261101` task is running.
- A timed Task Scheduler recovery guard was prepared and independently tested before cutover, disabled only after authenticated verification, then removed with the temporary migration task.
- Original executable and task definition remain under `%LOCALAPPDATA%\TetherplanePrivateTrial\20261101\rollback\no-console-20261101`.
- The legacy PowerShell browser task was disabled and its HKCU Run value backed up/removed. A proposed unsigned native browser launcher was blocked by Windows Application Control (error 4551); it was not forced or enabled at logon.
- No Windows reboot, Microsoft Store submission, privilege bypass, credential rotation, task deletion outside the temporary migration tasks, or unrelated shell termination took place.

## No-go gates

1. Browser provider is not currently advertised; a browser host running or extension merely present is not proof of authenticated pairing.
2. Leno Tailscale has exhibited `NoState` and reported Windows service crashes. No four-device connectivity recovery claim.
3. Reboot, sleep/resume, account logon, network loss/reconnection, and clean-install acceptance of the hotfix binary remain independently untested.
4. Public installer signing/trust, UI branding assets, automatic rollback on a newly authorized machine, uninstall, and multi-client acceptance remain incomplete.
5. This is private source evidence, not commercial customer usage, revenue, user growth, or production-readiness certification.

**Owner decision gate:** Release branch can proceed to review and distribution preparation, but a published version bump/tag requires explicit approval after these gates are tested.
