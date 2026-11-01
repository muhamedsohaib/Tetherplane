# Surface — private Windows relay and background-start acceptance (2026-11-01)

> **State: AUTHENTICATED / READY on the owner's real Surface.** **First real Windows reboot + logon-triggered agent recovery PASSED on 2026-11-01.** Private build only; no tag, protected merge, public installation or production-readiness certification. Sleep/resume, network interruption and repeated reboot tests remain untested.

## Why Surface was disconnected

An existing authorized agent process was alive, but its immutable `--arguments-file` still pointed at the older relay WebSocket port **10000**. The working Leno agent used the same locally verified relay host over `wss://` port **443**. A live process and an established socket on port 10000 were **not** proof of an authenticated relay connection.

The legacy Surface startup task invoked console-subsystem `tetherd.exe`, risking visible terminals. Attempts to run an unsigned PowerShell-based repair were correctly rejected by Surface's Windows execution policy. The owner did **not** weaken that policy, rotate device credentials, register replacement OAuth clients, or change scopes.

## Smallest safe intervention actually applied

1. Exported/preserved the original Surface Canary task and arguments file.
2. Staged the private Windows GUI-subsystem `tetherd-agentw.exe` compiled from source commit `d327117217c69e177019a6d6361c93870e579d79`. Independently verified binary SHA-256: `411e0f07f32ca3e6cf69a5ca53f3995e268946df419600bf0c807d737d00895c`.
3. Copied the agent arguments unchanged **except for relay port 10000 → 443**. The same device ID (`Surface`), existing credential-file reference, principal profile, allowed workspace and policy boundaries were preserved. Did not read credential values.
4. The owner manually imported a **separate initially disabled** native GUI-agent scheduled task, verified the executable and arguments, disabled the old Canary task and ended its old process, then enabled and ran the new task. Never intentionally operated two live agents with the same identity.
5. After confirming live authenticated connectivity, identified an obsolete October one-time rollback task with `StartWhenAvailable` still enabled. Exported its original XML to a local user-profile Diagnostics directory, **disabled** it, and preserved it for manual rollback. Did not delete the task.

## Independent real-device verification

| Test | Observed result | Limitation |
| --- | --- | --- |
| Authenticated Tetherplane `device.status(Surface)` | **ready**, `transport=authenticated`, `policy_mode=background_only` | One device and one active session |
| Tetherplane `device.capabilities` | Core device, filesystem, process, batch available; browser unavailable | Browser permission and pairing are not proven |
| Windows process inventory | Exactly **one** `tetherd-agentw.exe`; old `tetherd.exe` absent | Point-in-time verification |
| Installed executable | SHA-256 identical to private CI Windows build | No public signing claim |
| Live relay socket | One established TCP socket with remote port **443** | Does not independently prove TLS identity; authenticated Tetherplane status provides additional evidence |
| Live `process.run` on Surface | PowerShell `GetConsoleWindow() == 0`; `NO_CONSOLE_WINDOW`, exit **0** | Non-PTY child only |
| Negative permission boundary | Restricted `device.help` returned `permission_denied` | One specific denied capability; not the full matrix |
| Current scheduled task | `Surface_NoConsole_Port443_DISABLED_Task` is **Running**, despite “DISABLED” in its name | Display name is misleading; inspect state, not name |
| Logon configuration | Logon trigger enabled; `MultipleInstances=IgnoreNew`; 3 restart attempts, 1-minute interval; no runtime limit; battery allowed | These are settings, **not** verified crash/reboot recovery |
| Windows Task Scheduler Operational log | Enabled; IDs 100/110/129/200 recorded successful task start on November 1 at ~15:33 Dubai time | Task was manually run, not triggered by a new logon |
| Original Canary task | Disabled; original binary and task retained | Manual rollback is possible but the previous relay URL remains outdated |
| Obsolete October rollback task | Disabled after independent XML backup; live agent remains alone | No autonomous recovery test on this new private build |

Owner-machine evidence file:

`%LOCALAPPDATA%\Tetherplane\Diagnostics\SurfaceLogonAcceptance-20261101\surface-private-logon-acceptance-baseline.json`

Original rollback-task XML backup is stored alongside it. Neither file contains device-credential contents.

## Windows security and trust verification (2026-11-01)

A read-only Surface inspection established **Windows 10 kernel build 10.0.19045**, installed GUI-agent SHA-256 `411e0f07f32ca3e6cf69a5ca53f3995e268946df419600bf0c807d737d00895c`, and **Authenticode status NotSigned**. The previous `.ps1` repair was rejected by local script-signing policy, so the owner used a separate native Task Scheduler import without disabling that policy.

**Smart App Control is not available on Windows 10.** Surface therefore proves permitted agent execution under its actual Windows 10 restrictions—not Smart App Control enforcement compatibility. That stronger test must be performed independently on Windows 11. [Microsoft Windows Security reference](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app).

## First real reboot and automatic logon acceptance — PASS (2026-11-01)

After the owner performed a normal Windows **Restart** and signed in, the assistant independently reconnected through the existing Tetherplane plugin, queried Windows Task Scheduler events, inspected native process and socket state and ran authorized real-device tests.

| Independent measurement | Verified observation |
| --- | --- |
| Windows last boot | **2026-11-01 12:26:20.500 UTC** (16:26:20.500 Dubai) |
| Windows Task Scheduler logon trigger | **Event ID 119**, **2026-11-01 12:27:19.192 UTC** |
| Task action / process start | Events **129, 100 and 200** at approximately **12:27:19.200 UTC** |
| Native agent process creation | **12:27:19.199 UTC**, PID **7600**, after this boot |
| Boot-to-agent-launch | Approximately **59 seconds**. This is **not** an authenticated time-to-ready metric. |
| Active scheduled task | `Surface_NoConsole_Port443_DISABLED_Task` **Running**, enabled logon trigger, `MultipleInstances=IgnoreNew` |
| Old tasks | `Tetherplane Surface Canary` and obsolete rollback **Disabled** |
| Process inventory | **Exactly one `tetherd-agentw.exe`**, no `tetherd.exe`; executable path exactly matches staged private package |
| File integrity | SHA-256 `411e0f07f32ca3e6cf69a5ca53f3995e268946df419600bf0c807d737d00895c` |
| Relay transport | Agent had an **established TCP connection to remote port 443** |
| Authenticated MCP status | `device.status(Surface)` returned **ready**, `transport=authenticated`, `background_only` |
| Genuine post-reboot process execution | Windows non-PTY PowerShell `GetConsoleWindow()` returned **`NO_CONSOLE_WINDOW`**, exit **0** |
| Negative permission check | `device.help` returned the expected **`permission_denied`** |
| Leno availability during Surface restart | **Authenticated and ready**; deliberately left running as the recovery route |

**Interpretation:** Task Scheduler's **119** logon-trigger event and matching agent creation time establish that **the configured Windows logon trigger launched the new GUI-subsystem agent after reboot**, not a manual task run. The live Tetherplane status establishes that authenticated transport subsequently recovered. The exact time at which the agent first authenticated was **not captured**, so time-to-ready must not be estimated from the 59-second boot-to-process interval.

**Limits:** The post-reboot command proves an invisible non-PTY child at test time; it does **not** independently prove whether *any* terminal flashed during the sign-in sequence. Only one reboot/logon cycle has passed; startup across sleep/resume, intermittent network outages, force-kill/crash, other user accounts and clean installs remains untested. No credentials, OAuth, task settings, or Windows policy were modified during these checks.

## Remaining independent acceptance gates

**Surface's first actual reboot/logon recovery is now PASSED.** For the next acceptance session, keep the current Surface agent running as a known-good control and test **Leno** in a separate owner-approved restart window. Remaining tests on Surface must be planned separately:

1. Reboot/sign-in **Leno** while Surface stays available; verify native logon trigger, one agent, SHA-256, authenticated status, no-console test and preserved scopes.
2. For **Surface**, repeat restart/logon and record actual time-to-ready with a timestamped independent watcher before claiming a reconnect-time SLA.
3. Test Surface and Leno sleep/resume, transient network loss and an induced agent failure with measured rollback/recovery.
4. Complete clean-install/trust acceptance, exact logo packaging and browser feature gates; do not consider a passing reboot equivalent to distribution readiness.

**Historical pre-reboot checklist below is superseded by the verified logon event and acceptance table above.**

**Release gate remains open** for clean-install repeatability, user-visible icon packaging, other devices (RTX is deliberately powered off), browser enrollment, recovery/rollback under failures, and trust/signing. The agent reports version `0.1.0` although its private executable differs from the published `v0.1.0` release.

## Reusable onboarding improvement

Use the correct `wss://` port **443** from the start, a properly packaged GUI-subsystem executable, an immutable arguments-file handover, staged **disabled** task import, zero-duplicate acceptance, and a local rollback snapshot. Do not depend on unsigned PowerShell execution or confuse “task running” with authenticated connectivity. Record a reproducible hash and actual-device logs on every new install.
