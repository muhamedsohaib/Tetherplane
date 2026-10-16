# Controlled acceptance, deployment and rollback

Status: PREPARATION ONLY. No live changes or release approval.

## Next local gate: existing test-process cleanup

Leno only; background_only. Existing protected resources identified during this
continuation:

| Root PID | Created UTC | Ownership evidence |
| --- | --- | --- |
| 3588 | 2026-10-16T03:55:33.0474010Z | Playwright Chromium 1244; tether-chromium-profile-rYezWH; launcher parent 12800 absent |
| 10544 | 2026-10-16T04:05:22.4403260Z | Same executable; tether-chromium-profile-6Zw5rI; launcher parent 12584 absent |
| 5360 | 2026-10-16T04:18:49.6856380Z | Same executable; tether-chromium-profile-wtZlaa; launcher parent 8388 absent |
| 772 | 2026-10-16T04:04:15.6982480Z | Existing pnpm workspace test runner; Tetherplane handle proc_d555786b4fe04c8c8d873aab61fbd5bc |

Revalidate PIDs, creation times, executable paths, arguments and descendant
ownership immediately before any cleanup. A PID alone is not authorization.
Do not stop a mismatched, unreadable or unrelated process. Preserve test logs and
profiles until cleanup and regression evidence are captured.

The existing process.terminate request was approval_required. Obtain the
appropriate local-agent authorization or have the local operator perform the
scoped cleanup. Do not issue Stop-Process/taskkill through a different agent
execution route to bypass that decision.

After cleanup, run the isolated Chromium OAuth test with an external process
inventory before/after it. Require: callback/state/CSP assertions, bounded exit,
debugger listener closed, and zero processes using its unique test profile.
If the private debugger file never appears, fail the cleanup gate; do not infer
success from the launcher's exit or kill a recycled PID.

## Operator-observed human coexistence

Do not run the desktop, browser coexistence or foreground-probe tests unattended.
Agree a short, bounded window on Leno.

1. Awake, untouched desktop: record the current foreground state and run the
   fixture. Confirm cursor, clipboard, active window/tab and human resources
   remain unchanged. New COEXISTENCE diagnostics contain operation, cursor,
   foreground handle, input tick and clipboard sequence only.
2. Human activity: separately verify that the operator can type/move normally
   and retains foreground control while semantic actions affect only owned test
   resources. Human movement is not evidence of an automation fault; it also
   cannot be used to turn a failed untouched-desktop assertion into a pass.
3. Check per-operation traces for set_value, invoke and select. Input-tick
   changes are correlation evidence; they do not identify the actor.
4. Verify human-owned tab/window mutation denial, invalid lease denial and
   private clipboard isolation. Keep every strict acceptance assertion.
5. Verify all test fixtures close and the original human workspace remains usable.

Only then establish a fresh full Node suite result.

## Immutable Windows candidate and new-device acceptance

Use the private Windows kit workflow artifact built from the final pushed SHA.
Require the kit and sidecar hashes, manifest source_commit, source_tree_dirty=false,
and ZIP verification using the shipped binary. Do not label a local SkipBuild kit
as matching a commit unless its binary was built from that commit.

A clean Windows x64 machine or isolated clean Windows environment must be named
and authorized. Surface, Vaulter and RTX are not implicitly authorized by this
document. Leno's live installation must remain unchanged.

Acceptance must use the received ZIP without Rust/Node/pnpm, its own locally
generated credential, the required tailnet, and the existing ChatGPT connection.
Verify install, code approval for the expected device, finalize, real device.status,
least-privilege denial, supervisor restart, reconnect after transport loss,
reboot/sign-in recovery, repair, upgrade preservation, rollback and uninstall.
Record each result independently. Preserve unknown files and device state;
do not use the older general uninstaller as an assumed device-kit uninstaller.

The current workflow has not proved this full physical-machine lifecycle.
An unsigned private ZIP and tailnet-only transport remain explicit limits.

## Relay deployment gate

Prerequisites: required security/quality gates green, local live acceptance
complete, candidate identified, and explicit authorization to change Vaulter.
Do not deploy while any required test is red or unverified.

Before the approved change:
- Capture current relay launch action/version and configured paths without
  displaying configuration secrets.
- Back up relay code/config/device registry and preserve their ACLs locally.
  Do not print or copy credentials into chat, Git, or logs.
- Preserve both OAuth clients, issuer, resource/audience, account bindings,
  device registrations, Tailscale/Funnel configuration and Leno agent/policy.
- Confirm public HTTPS port 443, six-tool discovery through the existing
  authenticated connection, and Leno device.status.
- Prepare a separate candidate code directory; preserve the previous one.
  This candidate keeps registry format version 1.

During the approved deployment, change only the verified relay launch target,
using its existing configuration and state. Restart only the verified relay
service/task. Do not recreate the ChatGPT plugin, OAuth clients or device identity.

Afterward, recheck the same existing ChatGPT connection and Leno status before
approving any new enrollment. Test the additive relay-only approval operation
using the explicitly approved new device's displayed code and exact device ID.

## Rollback

Trigger rollback on authentication regression, missing tools, routing/account
isolation failure, persistent loss of Leno, pairing mismatch, or unsafe behavior.

Stop only the candidate relay, restore the prior relay launch target/code, keep
the existing auth configuration and current valid version-1 registry, and restart
the same relay service/task. Recheck HTTPS, six tools and Leno through the same
connection.

Do not automatically rewind the registry backup: that can undo subsequent
revocations or lose new approvals. Restoring state needs a separately reviewed
reconciliation of changes since the backup. Keep all diagnostic evidence
redacted. No public release, tag or announcement is included in deployment approval.
