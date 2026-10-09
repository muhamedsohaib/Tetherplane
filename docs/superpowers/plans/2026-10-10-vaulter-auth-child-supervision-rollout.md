# Vaulter authorization child-supervision v2 — gated rollout plan

**Date:** 2026-10-10
**State:** Candidate implementation only. Not installed or executed on Vaulter. Existing Auth0 relay and S4U v1 service remain live.
**Branch:** `feature/tether-auth-vaulter-migration-20261009`
**Canonical source:** GitHub and the Leno Tetherplane repository; Vaulter auth-stage is a staging checkout.

## Evidence and unresolved defect

- Registered S4U task `Tetherplane-TetherAuth-Startup` is running with `RestartCount=10` and `RestartInterval=PT1M`.
- The controlled restart trace saw the original task parent exit, task state become `Ready`, result `0x00000001`, and no auth listener through at least 115 seconds. The earlier completed rehearsal reported automatic restart FAILED and verified manual task recovery.
- After the latest exercise, an independent live postcheck verified the S4U-owned replacement auth listener PID `8748`, healthy local auth/relay, original Auth0 issuer, consistent public JWKS, and all four private Tailscale ports. The final automatic-versus-manual result for that particular run was not supplied.
- The *reason* Task Scheduler did not retry remains unproven; do not generalize its behavior from this one configuration. Do not reconfigure the task speculatively.

## Candidate reliability model

`scripts/vaulter-tether-auth-startup-runner-v2.ps1` is an isolated source candidate. The **existing** `scripts/vaulter-tether-auth-startup-runner.ps1`, registered task action and protected installed runner are unchanged.

The candidate retains the existing protected signing keys, bridge credential, issuer, SQLite state, loopback ports, Windows S4U identity, and original relay. Its `-Validate` path remains read-only/probe-safe. In `-Serve` mode, the task-owned PowerShell parent:

1. Verifies the registered task is enabled/S4U and port `8790` is vacant; never kills an unknown process.
2. Launches exactly one attached Node authorization child and waits for it to exit; no extra task registration or foreground actions.
3. Treats every unexpected child exit (including exit code zero) as a recovery event; backs off exponentially with a maximum restart delay of 60 seconds.
4. Resets backoff after a five-minute healthy child lifetime; applies a bounded rate rather than an unbounded spin loop.
5. Stops and reports a sanitized failure if the task ownership, port-vacancy guard, or launch/observation becomes invalid. Does not print raw stdout/stderr, task action arguments, bridge credentials, secrets, or private signing material.

This model leaves the Windows Scheduled Task responsible for startup and process ownership, while its child restarts become a responsibility of the protected runner. It is a **proposed architecture change** and requires a separate controlled live deployment decision.

## Protected runner upgrade tooling — source-only

The feature branch now contains a read-only-by-default upgrade script, `scripts/vaulter-tether-auth-runner-upgrade.ps1`, plus `scripts/vaulter-tether-auth-runner-integrity.ps1`. The independent supervised postcheck and crash-recovery preflight use the same exact SHA-256 v1/v2 source identity check. The registered S4U task action, original v1 source runner, protected live runner and active service remain unchanged.

The upgrader verifies a clean fetched feature checkout, original task state and definition, unchanged task-owned listener PID/creation time, protected state directory, and existing Auth0/JWKS/Funnel health. `-ApplyV2` (explicit) backs up the original installed v1 into `tether-auth-startup-runner.v1-backup.ps1` in the protected auth directory, then uses a same-directory Windows atomic file replacement to install the known v2 bytes. It compares owner, group, effective DACL rights/types and inheritance policy on both installed and backup files, rather than falsely requiring identical Windows-inherited SDDL serialization. Failures attempt verified restoration; unverified rollback leaves private recovery evidence and stops.

`-RestoreV1` (explicit, separate) uses the exact protected v1 backup and restores only the on-disk runner. Neither mode stops an auth process, restarts a Scheduled Task, changes credentials, overwrites an existing v1 backup, or changes Tailscale/Funnel/relay routes. Disk-version verification **does not prove which version an already-running PowerShell parent loaded**; a later, separately controlled task-instance refresh is mandatory.

PowerShell 5.1 and 7 targeted tests now exercise real NTFS-like temporary file swap and rollback (not only mocks), untrusted runner hash rejection, ACL-equivalence checks, backup overwrite refusal, cross-directory rejection, and transaction failure handling. The full Windows/Ubuntu repository quality gates must pass at the exact implementation revision before any live apply is considered.

### Remaining pre-activation proof

- **Code-level gate implemented:** `vaulter-tether-auth-autostart.ps1 -ProbeV2` uses a new one-time temporary S4U task to run the v2 `-Validate` path under the existing principal. The candidate checks S4U access to the existing registered task, protected files, Node runtime and local relay/auth endpoints. The temporary task and probe artifacts must be removed before it writes `tether-auth-runner-v2-probe.json` to the protected state directory. The proof records only the SHA-256 source hash, S4U/task labels and an ISO timestamp; the upgrader refuses v2 installation unless the exact hash matches and proof is fresh. This probe is **not read-only**, because it temporarily registers/removes an isolated probe task; it must be explicitly invoked by the Vaulter operator.
- **Still unverified live:** The temporary S4U v2 probe, permission to inspect the existing Scheduled Task under S4U, source-hash proof in the actual protected directory, and installation of v2 are not yet tested on Vaulter. Code-only Windows PowerShell 5.1/7 contracts do not establish these live capabilities.
- Require a reviewed deployment maintenance window and independent verification of protected backup, exact source hashes, task definition and original auth PID. A successful on-disk file upgrade is not activation.
- Execute controlled `-RefreshSupervisor` only after a validated v2 S4U probe, passing upgrade postcheck, and a recovery plan that can restore v1 and regain a healthy auth task. Reserve `-Exercise` and reboot for later, separately authorized windows.

### Safe, read-only Vaulter check after CI is green

~~~powershell
$repo = Join-Path $env:USERPROFILE 'source\Tetherplane-auth-stage'
git -C $repo status --short
git -C $repo branch --show-current
git -C $repo pull --ff-only
git -C $repo rev-parse --short HEAD
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\vaulter-tether-auth-runner-upgrade.ps1')
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\vaulter-tether-auth-supervised-postcheck.ps1')
~~~

Do **not** pass `-ApplyV2` or `-RestoreV1` during this preflight. Both the protected-file upgrade and the isolated `-ProbeV2` temporary task require separate operator action, and their live acceptance has not happened. Neither should be combined with `-RefreshSupervisor` or `-Exercise`.

## Verification and rollout gates

### Gate A — code and isolated simulation

- Start with failing Windows PowerShell 5.1/7 contracts, then minimum implementation.
- Verify collision refusal, exit-zero retry, bounded exponential backoff, reset after stable uptime, malformed results and failing callbacks.
- Pass Windows/Ubuntu staging and complete repository quality gates at the candidate commit.
- Check that the v1 runner blob remains unchanged and v2 has no external communication, financial action, task registration or foreground behavior.

### Gate B — deployment tooling, before any Vaulter upgrade

- Implement a **read-only-by-default** protected-runner upgrade procedure with separate explicit apply mode.
- First add version-aware, exact-source-hash guards to the independent postcheck and recovery preflight; accept only repository-verified v1 or v2 bytes, never arbitrary installed code.
- Verify the installed original v1 is backed up inside the existing protected auth-state directory. Stage v2 atomically and verify protected ACLs and hashes.
- Preserve the existing task action, S4U principal, startup trigger, restart settings, SQLite, keys and bridge secret. No Funnel or relay change.
- Any write failure must report whether v1 rollback is independently verified. Do not continue after an unverified state.
- Probe v2's S4U-access permissions and its read-only checks before an interrupting switchover.

### Gate C — supervised activation (maintenance window; live authorization required)

- Obtain fresh preflight, original task-owned PID and protected-file hashes.
- Intentionally rotate only the named Tetherplane S4U task instance with the existing guarded `-RefreshSupervisor` mechanism.
- Require a new task-owned PowerShell parent and Node child, local/public health, exact public signing keys and preserved Auth0/relay/Funnel/private-port configuration.
- Independently verify v2 installed source, ownership, no duplicate port listener, and readiness. Roll back to the protected v1 backup and recover the task if verification fails.

### Gate D — automatic recovery acceptance (separate maintenance window)

- Run a single guarded `-Exercise` against the verified task-owned Node PID.
- Capture sanitized observations of parent continuity and new child PID. Expected v2 success: new healthy task-owned Node listener **without manual recovery**, usually under the same task-owned PowerShell parent.
- Distinguish in-runner child recovery from Windows Task Scheduler re-launch. Any manual fallback means this gate failed.
- No repeated fault injection without a new reviewed diagnosis and healthy baseline.

### Gate E — boot and identity cutover

- Independently test unattended reboot recovery only with explicit reboot approval.
- Then separately verify online paired device, device-assisted OAuth login, path-specific Funnel mounts, PKCE/registration/refresh/revocation, relay issuer switch with rollback, authenticated six-tool ChatGPT acceptance and Policy Broker denials.
- Retire Auth0 only after all live gates pass.

### Read-only versus live modes

The protected-file upgrader without switches only inspects source hashes, registered task and health. `-ProbeV2` temporarily registers, starts, and removes a separate task and writes a short-lived proof marker; it intentionally does not stop or change the permanent task. `-ApplyV2` modifies the protected on-disk runner but does not restart the existing instance, and `-RestoreV1` is a separate recovery action. Neither `-RefreshSupervisor` nor `-Exercise` is automatically authorized by the other modes. A reboot and the OAuth issuer cutover require their own approval and verification gates.

## Current stop conditions

**Do not overwrite the protected runner or run `-RefreshSupervisor`/`-Exercise` merely because v2 code tests pass.** A production runner-file upgrade and reboot are separate, potentially disruptive actions. Keep Auth0 active and the existing public root/`/mcp`, `/jwks` and four tailnet-only ports unchanged. No project completion claim before live acceptance.
