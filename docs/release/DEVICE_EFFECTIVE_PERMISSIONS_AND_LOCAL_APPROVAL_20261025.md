# Tetherplane Device Authority — Effective Access & Local Approval
Date: 2026-10-25 (Asia/Dubai)
Source branch: feature/device-permissions-truth-20261025
Parent checkpoint: f100933a6cffd64f545a84380209f6e3e3fb5e16

## Problem

The original Control Center displayed device.capabilities inventory, which could misleadingly imply effective account permission. RTX permitted real process and batch operations, denied desktop.snapshot for the tested operator principal, had no browser provider, and blocked filesystem paths outside the local allowlist. Provider presence is not an OAuth grant.

The existing five Control Center restriction toggles are deny/revert overlays and cannot authorize device-local capabilities.

## Implemented in isolated candidate

1. Access truth: authority-access.mjs computes provider_unavailable, no_operations_advertised, portal_restricted or not_verified. None is presented as an allowed grant. Advertised operations are displayed separately.
2. Explicit exact-operation probes for the signed-in portal OAuth account: device.status, browser.status if provided, filesystem.info on one typed absolute path, and an opt-in fixed temporary process echo. The portal classifies only the exact tested operation as verified_allowed, denied, portal_restricted, provider_unavailable or not_verified. A successful transport response alone is insufficient: filesystem.info must report the exact requested path, a recognized type and a nonnegative size, and browser.status must return recognizable availability and mode fields. Empty or mismatched responses remain not_verified; an unavailable browser is reported as provider_unavailable. No file contents or desktop screenshots are exposed.
3. Reviewed owner request: same-origin, CSRF-protected POST with verified relay account/device pairing; exact capability, one device, owner fingerprint, reason and 24-hour expiry. It produces a downloaded non-executing JSON proposal. Desktop.snapshot can be requested for operator review even when the provider is present but the operation is not advertised. An unavailable provider remains unavailable until separately configured.
4. Device-local operator tool: scripts/Approve-TetherplaneDevicePermission.ps1 has Inspect (read-only), Apply and Restore. Apply requires a matching old principal SHA-256, protected Windows ACLs (only Administrators and SYSTEM can write), elevated local interactive approval, device ownership, exact capability and reason, and existing allowed filesystem roots. It creates a backup and recovery receipt before atomic replacement. Restore refuses any concurrent file change and preserves displaced evidence. Neither mode restarts an agent.
5. No silent root expansion. A requested directory outside the existing principal roots fails, because the agent's separate launch --allow flags also constrain access. Such an expansion needs a separate approved device-local change with independent recovery testing.
6. Already-enrolled Control Center editors no longer see the redundant Copy Verified Owner Proof invitation.

## Authorization boundaries

- Agent launch-bound policy, existing OAuth client, relay scopes and the four-device identities are unchanged.
- The download is an untrusted review request, not a cryptographic authorization token or device grant. The device operator must independently review it. The portal cannot directly write principal files.
- Local elevation and console checks are not cryptographic proof of physical presence. The real boundary is the protected device-local profile ACL and a non-elevated Tetherplane agent identity. Do not apply if the agent can edit the protected profile or launch elevated processes.
- A changed profile does not change a running daemon. The separately approved agent restart, verification of effective roots and rollback are still required. Do not use remote process execution to evade local permission denials.

## Isolated acceptance evidence

- Node adapter tests: 62/62 PASS.
- Headless Edge original private artwork test: PASS, including synthetic authenticated access checks, proposal download, existing deny and rollback, non-owner denial and stale-response fencing. Actual device policy changes: 0.
- Windows PowerShell 5.1 approval script syntax: PASS.
- Synthetic Leno local-policy test: 6/6 PASS. It proves read-only inspection, denial of wrong device/expired request/out-of-root access and no file write when noninteractive, plus receipt validation refusal. It does NOT prove a privileged production Apply or Restore.
- Original VAULTER baseline reconstructed exactly after normalizing Windows checkout line endings; production server SHA-256 aa6bdab77879780aa5bf3164aba1a2b51d50df8b117fa74e68221d84cf7353b8.

## Remaining acceptance and release gates

The current VAULTER Control Center and RTX remain unchanged. The candidate is not deployed, merged or pushed. No device permission or OAuth scope has been expanded.

Before any production permission grant: test an elevated local Apply, protected policy ACLs, correct authorized restart and new effective operation, out-of-root denial, receipt-backed Restore and recovery on a disposable authorized Windows machine.

Before showing the new screen on VAULTER: independent real OAuth browser proof, reviewed source/package, approved protected cutover and rollback. Never infer the portal's authority from a different connector principal.

This change corrects misleading permission visibility and provides a request/approval handoff. It does not claim a finished remote device permission administration system or fully functional RTX file/desktop workflows.
