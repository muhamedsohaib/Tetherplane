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

## Current stop conditions

**Do not overwrite the protected runner or run `-RefreshSupervisor`/`-Exercise` merely because v2 code tests pass.** A production runner-file upgrade and reboot are separate, potentially disruptive actions. Keep Auth0 active and the existing public root/`/mcp`, `/jwks` and four tailnet-only ports unchanged. No project completion claim before live acceptance.
