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
- During the **initial handover**, no Windows reboot, Microsoft Store submission, privilege bypass, credential rotation, task deletion outside the temporary migration tasks, or unrelated shell termination took place. The owner **subsequently rebooted Leno on November 1** and independently passed one real automatic logon-recovery cycle (see below).

## Windows security and trust verification (2026-11-01)

Read-only validation on actual Leno showed **Windows 11 kernel build 10.0.26300**, the exact installed GUI-agent SHA-256 `411e0f07f32ca3e6cf69a5ca53f3995e268946df419600bf0c807d737d00895c`, and **Authenticode status NotSigned**. Windows Code Integrity Operational events **3033** and **3077** were observed, without extracting their target paths or causes; a separate unsigned native browser launcher was previously blocked (Windows error 4551). The private agent continued running normally without any Windows security-policy modification.

**Smart App Control enforcement mode (On / Evaluation / Off) has not been independently verified on Leno.** Running one unsigned candidate successfully is not evidence that it would always pass reputation or signing rules on a clean Windows 11 installation. A true enforcement trial and approved trusted-distribution method remain release gates.

See [the complete Windows recovery timeline and platform-security distinctions](../operations/2026-11-01-windows-private-recovery-log.md).

## First real Windows reboot and automatic logon acceptance — PASS (2026-11-01)

The owner restarted Leno normally and signed into Windows. The assistant then used the existing authenticated Tetherplane plugin to query the native Windows boot record, Task Scheduler Operational events, task state, process inventory and live WebSocket TCP connection. **No manual Tetherplane launch, machine security setting, OAuth client or device credential was changed to pass this acceptance test.**

| Independent measurement | Verified observation |
| --- | --- |
| Windows last boot | **2026-11-01 13:27:12.500 UTC** (17:27:12.500 Dubai) |
| Logon-triggered task event | **Event ID 119**, **13:27:25.272 UTC** |
| Windows scheduled task/action/process events | IDs **129, 100, 200** around **13:27:25.278 UTC** |
| Agent process creation | `tetherd-agentw.exe` **PID 8120**, created **13:27:25.276 UTC**, after this boot |
| Boot-to-agent-process-start | Approximately **13 seconds**; **not** an authenticated time-to-ready metric |
| Active scheduled task | `Tetherplane Private Agent NoConsole 20261101` — **Running**; enabled Windows logon trigger; `MultipleInstances=IgnoreNew`; 3 restart attempts at one-minute interval |
| Old private task | `Tetherplane Private Agent 20261101` — **Disabled**, preserved |
| Actual process inventory | **Exactly one** `tetherd-agentw.exe`; no legacy `tetherd.exe`; expected private executable path |
| Same verified build | SHA-256 `411e0f07f32ca3e6cf69a5ca53f3995e268946df419600bf0c807d737d00895c` |
| Relay | **Established** agent TCP connection to remote **port 443** |
| Authenticated Tetherplane `device.status(Leno)` | **`transport=authenticated`**, **`state=ready`**, **`policy_mode=background_only`** |
| Actual post-reboot non-PTY command | PowerShell Win32 `GetConsoleWindow() == 0`, `NO_CONSOLE_WINDOW`, exit **0** |
| Explicitly denied operation | `device.help` returned **`permission_denied`** for principal `human:owner` |
| Independent fallback control device | Surface remained **authenticated and ready** during the Leno check |

**Why this proves automatic start:** Task Scheduler's event **119** identifies a Windows logon-triggered start, and native process creation and task/action events immediately followed. These observations distinguish the actual scheduled autostart from a manual run. The separate live MCP status confirms authenticated transport was recovered.

**Limits:** The first authenticated-ready instant was not measured; **13 seconds is boot-to-process-start only**. A non-PTY command that creates no console after startup does not prove that no window flashed at *any point* during sign-in. This was one reboot/logon cycle, not a repeatability or general-install test.

### Legacy scheduler items observed but not modified

- `Tetherplane Emergency Relay`: a separately named **`pythonw.exe`** task was Running at logon. This was not a second `tetherd` agent; its purpose and necessity were not audited in this acceptance test. Do not disable without a dependency assessment.
- `Tetherplane Leno Canary Rollback` and `Tetherplane Leno Canary Rollback V2`: both showed **Ready**, with expired single-use October 23 time triggers and `StartWhenAvailable=true`. Neither prevented this reboot from passing. **These stale tasks should be reviewed safely** before treating unattended upgrade/rollback as ready. No task or script was changed.
- The separate existing `Tetherplane Agent`, `Tetherplane Browser Bridge`, `Tetherplane Leno Agent`, and earlier Canary configurations were Disabled.

**Result:** Leno has passed **one** real reboot followed by authenticated automatic logon recovery. Surface passed its own independent reboot/logon cycle earlier on November 1. These are real-device acceptance gates, not proof of clean installation, code-signing trust, future uptime, browser capability, all four devices or production-readiness.

## No-go gates

1. Browser provider is not currently advertised; a browser host running or extension merely present is not proof of authenticated pairing.
2. Leno Tailscale has exhibited `NoState` and reported Windows service crashes. No four-device connectivity recovery claim.
3. **One real Leno reboot and logon-triggered recovery passed on November 1**. Further cycles, sleep/resume, network loss/reconnection, crash recovery, complete logon window-flash observation, measured authenticated time-to-ready and clean-install acceptance remain independently untested.
4. Public installer signing/trust, UI branding assets, automatic rollback on a newly authorized machine, uninstall, and multi-client acceptance remain incomplete.
5. This is private source evidence, not commercial customer usage, revenue, user growth, or production-readiness certification.

**Owner decision gate:** Release branch can proceed to review and distribution preparation, but a published version bump/tag requires explicit approval after these gates are tested.
