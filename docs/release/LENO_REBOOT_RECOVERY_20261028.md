# Leno post-reboot recovery boundary — 28 October 2026

**Physical device result: NO-GO.** This records a user-operated read-only Windows observation and separately authenticated ChatGPT/Tetherplane checks. It does not claim that a signed executable was produced, installed or accepted.

## Owner-observed post-reboot facts

| Field | Exact observed result |
| --- | --- |
| tetherd.exe process count | 0 |
| Tetherplane Leno Canary task | Ready |
| Canary last result | 1 (failed; not an attributed cause) |
| Saved task --relay-url | Missing |
| Saved task --device-id | Missing |
| Saved task --device-credential-file | Missing |
| Configured native agent signature | NotSigned |
| Post-reboot Code Integrity event query | UNAVAILABLE |

**Interpretation:** No Tetherplane native agent remained after reboot. The saved direct Canary action cannot establish the documented remote mode with the missing arguments. The native executable is not signed, and earlier Leno evidence showed Smart App Control enforcing. We cannot infer a post-reboot Event 3077 block from an unavailable event query.

## Independent current checks and access boundary

- ChatGPT authenticated Tetherplane status: Surface and VAULTER connected, Leno disconnected.
- A read-only Surface query through its permitted process capability showed Leno online in Tailscale and RDP port 3389 reachable.
- Remote WMI and Task Scheduler access to Leno through the current Surface Windows identity returned ACCESS_DENIED. No credentials were requested and no escalation, RDP login or write attempt followed.
- Network reachability does not prove that the Leno device has an authenticated WebSocket in the relay's live routing map.

## Smallest safe intervention after a trusted signed candidate exists

1. Preserve Leno's current device pairing, local credential file, principal profile, current task definition, state and the existing owner-approved relay/identity. Do not print or copy credentials into chat or CI.
2. Verify a source-pinned, independent Authenticode-signed Windows native executable, correct file hash and provenance; physical Smart App Control acceptance is an additional gate.
3. Stage a separate reversible task using the approved existing identity, relay URL and credential-file reference. Fail without changing the existing task if admission or signature verification fails.
4. Confirm Leno returns authenticated device.status, safely denies an out-of-scope call, reconnects after reboot, and supports rollback before retiring any old task.
5. Do not disable Smart App Control, re-pair the device, register replacement OAuth clients, change production identity or publish unsigned Windows binaries.

## New source verification work

- New sanitized diagnostic: scripts/msix-store/Assess-Leno-PostReboot-ReadOnly.ps1. It produces machine-readable NO_GO or INCONCLUSIVE; neither is permission to install.
- New synthetic tests and a Windows PowerShell 5.1 GitHub Actions job. Only Windows disposable runner simulations are authorized. They do not contact Leno or change a task, registry or executable.
- Existing draft PR #71 remains the Windows scheduled-task fail-before-install guard. This PR is a child, not a replacement or permission to merge #71.

## Remaining release gate

**No signed native agent accepted on Leno, no reconstructed authenticated startup, no scope-denial/reboot/rollback evidence, and no release authorization.** Until these pass, Leno recovery and broad Windows distribution remain NO-GO.
