# Surface — private Windows relay and background-start acceptance (2026-11-01)

> **State: AUTHENTICATED / READY on the owner's real Surface.** Private build only; no tag, protected merge, public installation or production-readiness certification. The **next actual Windows sign-in, reboot and sleep/resume have NOT been tested** with this replacement agent.

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

## Next independent acceptance gate

**At the next natural owner-approved Windows sign-in** (do not remotely force sign-out or reboot a computer actively in use):

1. Capture the sign-in time, native task launch events (Task Scheduler Operational), and the new agent's process creation time. Confirm an actual *logon-triggered* start, not merely the November 1 manual run.
2. Verify exactly one agent, no old `tetherd.exe`, no foreground terminal, and a verified hash of the current `tetherd-agentw.exe`.
3. Call authenticated `device.status(Surface)` and check the relay reconnected without changing the credentials or policy. Record time-to-ready from the task's start event; do not guess a metric.
4. Test a permitted read-only command and an explicitly denied capability.
5. After that, separately evaluate reboot and sleep/resume on a suitable maintenance window, plus interruption recovery. Keep Surface's working task, snapshot and identity intact until independently proven.

**Release gate remains open** for clean-install repeatability, user-visible icon packaging, other devices (RTX is deliberately powered off), browser enrollment, recovery/rollback under failures, and trust/signing. The agent reports version `0.1.0` although its private executable differs from the published `v0.1.0` release.

## Reusable onboarding improvement

Use the correct `wss://` port **443** from the start, a properly packaged GUI-subsystem executable, an immutable arguments-file handover, staged **disabled** task import, zero-duplicate acceptance, and a local rollback snapshot. Do not depend on unsigned PowerShell execution or confuse “task running” with authenticated connectivity. Record a reproducible hash and actual-device logs on every new install.
