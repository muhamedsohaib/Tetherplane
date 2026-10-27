# Leno canary boundary — evidence checkpoint (2026-10-27)

Status: **NO-GO; read-only Leno observations, no repair or installation**.

## Exact software references

- Repo: `muhamedsohaib/Tetherplane`
- Diagnostic draft PR: #70, `feature/leno-readonly-preflight-20261027`
- Latest Store-runtime draft: #69 at `25c5e7f34cc7c2b7cf440d7b30db7e979610deec`. Its GitHub Windows/Ubuntu CI and MSIX G2 jobs passed but **that does not mean the new version is installed on Leno**.
- Leno native agent version/hash: **unverified**. Read-only process signature/hash was `UNAVAILABLE`. No Tetherplane MSIX package registered for the querying user.

## Observed Leno — user-operated read-only PowerShell

Observations are from the user's Leno terminal, not independently corroborated by a privileged remote session.

First snapshot, `2026-10-27T19:55:53.3798832Z`:

| Measure | Observation |
|---|---|
| Windows build | 26300 |
| Tailscale service | Running |
| Native `tetherd.exe` process | PID 20396 |
| Tetherplane Leno Canary task | Running |
| Tetherplane Emergency Relay task | Running |
| Older Tetherplane Agent / Tetherplane Leno Agent | Disabled |
| Active agent executable hash/signature | UNAVAILABLE |
| Tetherplane MSIX in current user scope | None |
| Raw SAC registry status | `VerifiedAndReputablePolicyState=1`; policy indicated enforcement, independently observed block below |
| Code Integrity | `3077` for `tetherd.exe` at `2026-10-27T08:00:45.0996612Z` |

Second snapshot, `2026-10-27T20:30:31.3320182Z`:

| Measure | Observation |
|---|---|
| Tailscale backend / self | Running / online |
| Leno Canary | Running, last run `2026-10-27T08:01:46Z`, result `2147946720` = `0x800710E0` |
| Emergency Relay | Running, last run `2026-10-24T07:42:54Z`, result `267009` = `0x41301` |
| `tetherd.exe` PID 20396 TCP | 1 Bound, 1 Established |
| Actual authenticated connector status | `device.status(Leno)` still returns `disconnected` |

Interpretation: `0x800710E0` wraps Windows `ERROR_REQUEST_REFUSED` (4320; generic 'operator or administrator has refused the request'). It **does not identify** which policy, condition, or scheduler operation refused this launch. `0x41301` is Task Scheduler's normal `SCHED_S_TASK_RUNNING`, not a failure. The Code Integrity 3077 timestamp precedes the recorded canary run by approximately 61 seconds; coincidence in time is not proof of causal linkage. An established TCP socket is not proof of authenticated relay access.

References:
- https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--4000-5999-
- https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-error-and-success-constants

## Failed boundary and smallest next observation

The failure is **above basic tailnet reachability**: the existing plugin cannot authenticate/route a `device.status` request to Leno, despite the local agent process and Tailscale being up. Whether the process is connected to VAULTER, localhost, another tailnet peer, or a non-tailnet socket remains unknown. Whether task scheduler refused an extra launch, or SAC blocked a different executable attempt, remains unknown.

The read-only script `scripts/msix-store/Inspect-Leno-Canary-Boundary-ReadOnly.ps1` records:
- Exact canary last result and safe task settings (no task action arguments).
- Process creation timestamp to determine whether PID 20396 predates the blocked launch.
- Established socket **peer category only**; no destination IPs or URLs.
- Bounded Task Scheduler Operational event IDs/times correlated with canary, and Code Integrity 3077 event IDs/times (no event messages or executable paths).

The script has no policy, task or installation mutation. It was parsed, statically screened and run in disposable GitHub-hosted Windows PowerShell 5.1 CI (#40579436996). **CI is not the Leno observation.**

## Do-not-touch and release gate

Do **not** disable Smart App Control, replace device credentials, restart or re-enable disabled Tetherplane tasks, change relay identity/authentication, modify the user profile ACLs, or install the development-signed MSIX onto this active canary without a separately approved, reversible, signed trial.

Remaining gate: trusted/signed installation and real-world on-device owner-approved pairing, other-user denial, relay acceptance, reconnect, removal/rollback, and independently verified four-device operation. **Release NO-GO.**
