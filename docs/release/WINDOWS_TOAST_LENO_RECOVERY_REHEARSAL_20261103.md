# Leno exact-version recovery rehearsal — November 3, 2026

**Scope:** Windows Notification Developer Beta; no production switch, no Store release. All remote Windows commands in this continuation used Tetherplane. Remote Desktop Commander was not invoked.

## Starting point

- Working branch: `feature/windows-toast-notifications-design-20261103`.
- Started from the verified GUI-notification acceptance evidence commit `814f221c353cd89b064684c426068188fa8f8dbb`. The earlier test source remains `72684903830c77c375d9a276bbbc4fc08ca9d5d8`.
- Protected Leno task: `Tetherplane Private Agent NoConsole 20261101`, state `Running`; exact one matching process, PID `15296`.
- Executable: `tetherd-agentw.exe`, SHA-256 `411E0F07F32CA3E6CF69A5CA53F3995E268946DF419600BF0C807D737D00895C`.
- Read-only readiness preflight passed: single arguments-file switch and existing non-reparse file, without reading its contents.

## Reproducible isolated rehearsal

Run `scripts/windows/Test-LenoPrivateAgentRollbackRehearsal.ps1` from an authorized interactive Windows user account on Leno.

The script checks the existing task/agent/hash without modifying them, copies only the executable to a unique temporary sandbox, simulates a bad new binary, and enforces the exact SHA-256 before restoring from a verified backup.

**Observed on Leno:**
- PowerShell syntax parse: passed.
- Tampered rollback binary: rejected *before* overwriting the synthetic target.
- Verified baseline binary: restored successfully to the synthetic target with expected hash.
- Temporary test files: cleaned up automatically.
- Original task name, action, arguments, trigger count and running state: unchanged.
- Original agent executable SHA-256 and PID `15296`: unchanged.
- No synthetic agent execution or second device connection.
- Private arguments file contents and protected credentials: not read or copied.

A separate run with `-CreateOfflineBinaryBackup` passed the same checks and saved a **binary-only**, hash-verified copy at `%LOCALAPPDATA%\Tetherplane\Recovery\Leno-20261101\tetherd-agentw.exe`. Its hash was independently checked afterwards and equals the installed November 1 SHA-256. This is a local recovery asset, **not** proof of a fully functional rollback or independent remote access. It does not include private credentials, launcher arguments or task export.

## Independent-control-path audit

- Leno Tailscale service: running; backend connected/online with a private tailnet IPv4 address.
- Windows RDP: enabled; port 3389 listening; Remote Desktop firewall rules enabled.
- Local test from Leno to its **own tailnet address** on port 3389: TCP accepted.
- **NOT TESTED:** authenticating to Leno via Tailscale RDP from Surface/another device, independently of the Tetherplane session. The local self-test is not independent recovery proof.
- Legacy rollback scheduled tasks: present but have **not** been shown to restore the November 1 installation. Do not execute them in a protected recovery scenario without auditing their action.

## Decision / gate

**GO:** continue isolated developer-beta validation and implementation in a draft branch.
**NO-GO:** replace, restart, reconfigure or duplicate the protected Leno agent; change its OAuth/DCR/identity settings; or publish/merge. The prior safety authorization still applies.

**Next smallest operational step:** verify a real Surface-to-Leno Tailscale RDP login (using the owner's existing authorized credentials without sharing them), then rehearse an exact-November-1 rollback from that independent session without touching the active agent. With independent access established, prepare a reversible, one-device notification change for separate approval and measure actual first-connect latency and unknown-status event delivery. Do not assume this Leno test establishes readiness on Surface, Vaulter or RTX.
