# Windows private acceptance and recovery log — 2026-11-01

> **Status:** Verified owner-device evidence, not a public release certificate. This log is a durable retrospective record of facts observed on the machines and in GitHub. It is not a verbatim raw console log. Sensitive configuration values, credentials, tokens, client registrations, and private addresses are intentionally excluded.

## Exact tested candidate

| Field | Value |
| --- | --- |
| Source commit | `d327117217c69e177019a6d6361c93870e579d79` |
| Source PR | [#119](https://github.com/muhamedsohaib/Tetherplane/pull/119), open/draft/not merged |
| Documentation PR | [#120](https://github.com/muhamedsohaib/Tetherplane/pull/120), open/draft/stacked on #119 |
| Windows executable | `tetherd-agentw.exe`, GUI subsystem; not Authenticode signed |
| Installed binary SHA-256, **both Surface and Leno** | `411e0f07f32ca3e6cf69a5ca53f3995e268946df419600bf0c807d737d00895c` |
| Agent-reported version | `0.1.0` (do not treat the private binary as an already published newer version) |
| Focused Windows build and no-console test | [Actions 41281507337](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41281507337), PASS |
| Windows quality + Ubuntu quality + release policy | [Actions 41281511821](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41281511821), all PASS |
| Documentation-branch Windows/Ubuntu/release-policy CI | [Actions 41303340362](https://github.com/muhamedsohaib/Tetherplane/actions/runs/41303340362), all PASS as observed 2026-11-01 |
| Last published release | [`v0.1.0`](https://github.com/muhamedsohaib/Tetherplane/releases/tag/v0.1.0), published 2026-09-26; unchanged |

## What happened and what was actually repaired

| Step | Observed failure or boundary | Intervention | Real-device result |
| --- | --- | --- | --- |
| Leno process execution | A GUI-subsystem agent's ordinary non-PTY `process.run` launched PowerShell consoles that flashed in the human desktop | Windows-only `CREATE_NO_WINDOW` in the piped-child spawn path, independent Win32 regression test, separate private artifact | Live `GetConsoleWindow() == 0`; command emitted `NO_CONSOLE_WINDOW`, exit 0; authenticated agent remained alone |
| Leno migration | Old authenticated agent was the only verified route; stopping it without recovery would risk loss of access | Saved original executable/task XML, staged private candidate side-by-side, verified Windows execution, used independent scheduled recovery guard and authenticated acknowledgment | New windowless agent authenticated and ready; no duplicate; temporary guard removed only after acceptance |
| Surface stale route | Old `tetherd.exe` still running but device disconnected; arguments pointed to previous WSS port `10000` | Reused the already working relay hostname, changed port to **443** only in separate args file | Authenticated `device.status(Surface)` returned ready; established TCP remote port 443 |
| Surface private install | Original canary used console-subsystem agent; signed-script execution policy rejected an unsigned PowerShell repair | No execution-policy bypass. Staged the verified GUI executable; owner manually imported a **separate initially disabled** Task Scheduler task, then ended old agent and started new task | One `tetherd-agentw.exe`, no `tetherd.exe`, live non-PTY `NO_CONSOLE_WINDOW` exit 0 |
| Surface duplicate prevention | Potential for old canary or obsolete rollback to start another same-ID process | Old Canary left disabled. Obsolete October one-time rollback task had `StartWhenAvailable` true: backed up its XML then disabled it without deletion | One agent remained running, old rollback disabled |
| Surface policy | Access denied for `device.help` | **No grant or scope change** | `permission_denied` retained as expected negative control |
| Surface startup configuration | Reconnect after actual logon remains unknown | Inspected enabled logon trigger, `IgnoreNew`, 3 task restart attempts at 1-minute intervals, unlimited runtime and battery allowances; saved actual Task Scheduler event IDs 100/110/129/200 | **Configuration passed; no real new-logon/reboot/sleep acceptance yet** |
| Branding | Old branding variants were inconsistent with the final owner selection | Owner supplied exactly four approved monochrome originals on 2026-11-01; names/dimensions/SHA-256 recorded in [branding gate](../branding/ICON_DISTRIBUTION_GATE.md) | Sources identified; **assets not yet installed** in the existing plugin or a released installer |

## Current authorized Surface state

- Canonical live task is `Surface_NoConsole_Port443_DISABLED_Task` (the word `DISABLED` is part of its imported **name**, not its current state). Task state was **Running**.
- New executable is under `%LOCALAPPDATA%\Programs\Tetherplane\surface-port443-20261101\bin\tetherd-agentw.exe`; process inventory showed **PID 14636**, one agent, started approximately **15:33:28 UTC+04:00**. The PID is observational, not a permanent contract.
- The new task's logon trigger was configured and enabled; `MultipleInstances=IgnoreNew`, 3 restarts, 1 minute apart; `Tetherplane Surface Canary` and obsolete rollback were both disabled.
- Configured relay: approved hostname with WSS on port 443, `/device` path, correct `Surface` device ID; a URI-normalization false mismatch was resolved by direct URI-object comparison.
- Authenticated `device.status` reported `ready`, `transport=authenticated`, `background_only`; `process.run` with Win32 console check succeeded.
- Local evidence file: `%LOCALAPPDATA%\Tetherplane\Diagnostics\SurfaceLogonAcceptance-20261101\surface-private-logon-acceptance-baseline.json`.
- Obsolete rollback's saved XML: `%LOCALAPPDATA%\Tetherplane\Diagnostics\SurfaceLogonAcceptance-20261101\Tetherplane-Surface-Canary-Rollback-original-task.xml`. **Do not claim special ACL hardening without examining its access control.**

## Current authorized Leno state

- Task: `Tetherplane Private Agent NoConsole 20261101` running; previous `Tetherplane Private Agent 20261101` disabled, preserved for rollback.
- Same candidate executable SHA-256 as Surface; live authenticated `device.status`, non-PTY PowerShell `NO_CONSOLE_WINDOW` exit 0 and exactly one agent previously verified.
- Local backups and acceptance evidence: `%LOCALAPPDATA%\TetherplanePrivateTrial\20261101\`.
- Redundant legacy browser PowerShell autostart disabled after backup. Browser provider is **not** part of these successful Windows acceptance claims.

## Windows security / trust evidence

- **Leno:** Windows 11 kernel build `10.0.26300`; private `tetherd-agentw.exe` Authenticode status **NotSigned**, SHA-256 matched. Windows Code Integrity Operational events 3033 and 3077 were observed on 2026-11-01; their target/signature cause was **not** extracted from this read-only inspection. Earlier browser native launcher received OS application-control failure code 4551. **Actual Smart App Control mode (On / Evaluation / Off) was not independently established**; candidate execution does not prove policy bypass or universal trust.
- **Surface:** Windows 10 kernel build `10.0.19045`; same **NotSigned** executable ran. Its unsigned PowerShell repair script was rejected by enforced script-signing policy; the owner did not weaken it. **Smart App Control is not available on Windows 10.** Do not claim Surface was tested with Smart App Control enabled.
- Neither machine required disabling security controls, weakening PowerShell execution policy, altering OAuth/DCR, or reading device-credential contents to bring up the private agent.

External vendor reference: [Microsoft Windows Security — Smart App Control is not available on Windows 10](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app). This fact and exact OS versions matter for honest Windows release claims.

## Device and feature boundaries

- Surface and Leno: directly observed authenticated and ready with the private Windows candidate.
- VAULTER: existing `VAULTER` identifier responds to `device.status`, but that response exposed version/OS/policy fields **without** `agent_liveness.transport`; do not claim authenticated transport for VAULTER from that one response.
- RTX: intentionally powered off by the owner; **exclude from failure counts and do not claim four-device acceptance**.
- Browser capability: remains unverified/unavailable; no bypass of owner permissions was attempted.
- Tailscale Leno state had previously reported `NoState`; private WSS agent connectivity does not prove that Tailscale backend has been repaired.

## Release/no-go gates still open

1. **Surface passed one actual reboot/logon** (see follow-up below); remaining: Leno reboot/logon, repeated Surface cycles, sleep/resume, network interruption, evidence of no flashes at sign-in and measured authenticated recovery time.
2. Clean-install and clean-uninstall test from a trustworthy distribution path on a newly authorized machine, preserving device identity, owner consent and scopes.
3. Vendor-trusted installer/signature/reputation acceptance, including an independently **verified Windows 11 Smart App Control enforcement** trial.
4. Bundled monochrome official logo/icons with real installed-plugin/extension/Windows host verification.
5. Browser capability under explicit owner tab permission, plus a broader negative-policy matrix and multi-device acceptance.
6. Rollback under an induced failure and proof that the agent can recover without this chat/session.

**Release state:** **NO-GO for general availability.** This is a promising private Windows candidate, not a tagged or generally distributed `v0.1.1`. Preserve original tasks and credentials; do not merge or publish without owner approval.

## Follow-up acceptance: Surface real reboot and Windows logon — PASS (2026-11-01)

The owner restarted Surface normally and signed back into Windows. The assistant reconnected through the **same Tetherplane app** without manually invoking the agent, then read the local Task Scheduler Operational log and Windows process/socket state.

- Windows boot: **2026-11-01 12:26:20.500 UTC** (16:26:20.500 Dubai).
- Task Scheduler **Event ID 119 (logon trigger)**: **12:27:19.192 UTC**. Task/process/action events **129, 100, 200** immediately followed at approximately **12:27:19.200 UTC**. This distinguishes an automatic logon-triggered start from the earlier manual task start.
- New `tetherd-agentw.exe` process: **PID 7600**, created **12:27:19.199 UTC** after boot, exactly **one** agent and **no old `tetherd.exe`**; executable location matched the verified private package.
- SHA-256 after reboot: `411e0f07f32ca3e6cf69a5ca53f3995e268946df419600bf0c807d737d00895c` (unchanged).
- Established agent TCP connection to remote **port 443**. Tetherplane `device.status(Surface)` returned **authenticated**, **ready**, **background_only**. Leno remained authenticated/ready throughout.
- Authorized real post-reboot PowerShell command returned **`NO_CONSOLE_WINDOW`**, exit **0**. Restricted `device.help` returned expected **`permission_denied`**.
- Active task remained **Running** with an enabled logon trigger and `MultipleInstances=IgnoreNew`; original Canary and obsolete rollback remained **Disabled**.
- Boot-to-agent-process-start was approximately **59 seconds**. The exact **first authenticated ready** timestamp was not instrumented, so no time-to-ready claim is made. Invisible post-reboot command execution does **not** prove that no window flashed during sign-in.

**Result:** One real Surface reboot/logon cycle with automatic agent startup and recovered authenticated control **PASSED**. This supersedes the earlier *pre-reboot* statement that Surface sign-in had not been tested. Do **not** generalize to Leno, multiple cycles, sleep/resume, network loss, signing/trust or clean installation.

Source: [Surface acceptance record](../release/SURFACE_PRIVATE_PORT443_ACCEPTANCE_20261101.md) and [machine-readable provenance](../release/windows-private-candidate-20261101.json). No Tetherplane config, Windows security policy, OAuth, credential, or scheduled-task settings were changed during this validation.
