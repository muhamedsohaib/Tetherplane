# Windows distribution integration checkpoint — 2026-10-23

**Status: engineering-only draft. Production distribution remains NO-GO.**

## Reviewed source boundaries

- Reliability source: draft PR #44, `fix/windows-agent-owned-task-ws-heartbeat-20261022`, accepted canary SHA `e7ba707a9354167bd0013f1c8dc4065d1244d5fd`. Surface and Leno have independently authenticated acceptance; Leno's V2.1 watchdog logged `ACCEPTED_NO_ROLLBACK`.
- Signing and first-device onboarding source: draft PR #16, `feature/windows-repeatable-onboarding-signed-kit-20261018`, commit `14f3143ea6f98036db3a5eecc55a0fe3b0af7896`.
- The branches have diverged and **must not be bulk-merged**. A successful test on one branch does not attest to their combined tree.
- The full frontend is deliberately deferred. The product target is *download -> signed install -> explicit pair/authorize -> independently connected*, with progress/repair guidance and no command-line steps for the ordinary user's successful path.

## Existing reusable signing and onboarding assets (PR #16)

- `scripts/setup-windows-device.ps1`, `pair-windows-device.ps1`, `doctor-tetherplane.ps1`, and `package-windows-device-kit.ps1`.
- `scripts/verify-windows-device-kit.ps1`, signing request/content-bound verification, a provider-neutral adapter, and a manual environment-protected `windows-trusted-signing.yml`.
- Windows signature policy tests and disposable onboarding tests. The old device-only kit is built to require no Node/Rust/pnpm on a newly installed computer.
- The above is **source and CI evidence only**. It is neither an approved signed candidate nor a current clean-install acceptance record.
- No signing provider, publicly trusted publisher certificate, protected ephemeral signing runner or approved provisioned identity was identified on Surface/Leno. Do not self-sign, weaken App Control, purchase a certificate, or provision signing environments without explicit owner approval.

## Mandatory compatibility boundary

PR #44 uses a **direct `tetherd.exe` Windows Scheduled Task** with `--arguments-file` and no PowerShell-spawned child. This fixed stranded agent processes and duplicate registrations.

PR #16's older `Install-DeviceAgentTask` still registers `powershell.exe` to run `launch/tetherplane-agent.ps1`. Do not reuse that task registration in a package claiming PR #44 reliability. Port the signed kit's own task-registration contract to the current native action while preserving its existing state-directory ACLs, credential identity, least-privilege `principal.json`, pairing approval, package authenticity, managed-file ownership journal and rollback.

Required cross-branch regression on an isolated Windows runner before any rollout:

1. Install into a fresh versioned prefix with a new disposable synthetic identity; no production OAuth clients, credentials, relay, tasks or state used.
2. Confirm exactly one native `tetherd.exe` process belongs to exactly one Scheduled Task and its action includes only the local argument-file path.
3. Stop the owning task; verify that the owned PID exits, no orphan remains, and no competing agent task is registered.
4. Restart, force a transport disconnect, recover, and independently authenticate `device.status` and a correct out-of-root `permission_denied`, without replaying uncertain mutations.
5. Verify update collision/partial-write journaling, repaired install, reboot/logon recovery, rollback and uninstall preserving device identity and unrelated files.
6. Re-run the standalone signing verification on every executable code path using independently approved publisher/leaf thumbprint and pinned source. A valid signature on unrelated content must not suffice.
7. Test the human first-run path with a person unfamiliar with PowerShell. Record time, manual steps, pairing friction, error clarity, and reversible failures. Do not call setup “one-click” until this passes.

## First isolated safety repair in this branch

The PR #44 legacy `scripts/install-windows.ps1` previously allowed `-Force` to recursively remove a nonempty install prefix, even if its contents were not managed by Tetherplane. That behavior is prohibited before a managed signed updater exists.

This branch makes `-Force` nondestructive for populated installs and rejects overlapping install/state trees. A synthetic-only Windows test verifies these fail closed and that fresh/empty installation paths remain supported. The tests never execute the dummy agent, connect to a relay, or create a Scheduled Task.

**This is a prerequisite safety repair, not a replacement for PR #16's more complete transactional managed installer.** The branch contains no signing material and no production deployment instructions.

## Release gates (not optional)

- Approved public-trust signing identity and provider adapter, exact-source signing, timestamp, validated archive/hashes, Smart App Control-safe Windows launch.
- Integrated native task ownership and user-friendly device-only onboarding without manual CLI steps.
- Clean authorized Windows VM test and independently observed rollback, reboot/reconnect and correct denial.
- Sustained live reliability soak on the existing accepted canaries, without altering their identities or relay.
- RTX as fourth device separately accepted; VAULTER remains on existing protected relay/agent.
- PR review and integration order resolved, then owner authorization for any merge, release, signing-provider purchase or production cutover.
