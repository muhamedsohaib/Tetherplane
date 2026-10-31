# V5 Leno release — certificate escrow and recovery scope

Observed: 2026-10-31 (Dubai). **PRODUCTION CUTOVER: NO-GO.**

## Current verified evidence

- Exact CI candidate: 3a6b530b2ad300661c46216f7d5cf9596a18c62f.
- Isolated Windows acceptance: https://github.com/muhamedsohaib/Tetherplane/actions/runs/41217433255 — 3/3 jobs successful.
- Standard Windows/Ubuntu CI: https://github.com/muhamedsohaib/Tetherplane/actions/runs/41217433262 — 3/3 jobs successful.
- Compiled Windows agent was unsigned and disposable. Signing and installed Windows 11 trust acceptance remain unverified.
- Vercel produced zero CI-branch deployments.
- Leno was authenticated and responsive; original agent 0.1.0 and background_only remained unchanged. Active owner was Tetherplane Leno Canary, one tetherd process, restart count 3 / interval 1 minute. A physical Windows logon/restart recovery was NOT executed.

## Precise remaining gap in VAULTER's existing ACL rollback receipt

The deployed V5 ACL hardening script (v3) previously produced a user-DPAPI-protected backup containing a copy of the Control Center code tree, one task XML, and DACL receipt. It does NOT by itself include the separately running relay, auth service configuration, device registration and pairing state, owner authority state, or all associated tasks. Its decryption depends on the original Windows user DPAPI profile.

An off-device copy of these existing DPAPI-encrypted bytes does NOT demonstrate recovery if the VAULTER profile is unavailable. Existing DPAPI backup and live ACL-hardening must be preserved, not overwritten.

## New synthetic portable-crypto test

Source: tests/release/v5-portable-certificate-escrow-synthetic.ps1.

- Generates an ephemeral RSA 3072-bit certificate without installing into the Windows certificate store, and synthetic-only test material.
- AES-256-GCM encrypts invented data and RSA-OAEP-SHA256 wraps its random key.
- A separate PowerShell 7 process independently loads a temporary PFX with EphemeralKeySet and restores verified synthetic data.
- Wrong private-key password, changed ciphertext, separately pinned SHA-256 mismatch and missing key all fail closed before an output file is written.
- Synthetic PFX/ciphertext/payload/test directory are removed afterward. Leno exit 0, no leftovers.

This demonstrates cross-process portability only, NOT an actual second-device restore. The test fixture keeps its pinned hash and test private key in the same temporary directory. No production archive, private key custody, long-lived certificate management or external recovery destination was created. It does not accept actual configuration or production bytes.

## New VAULTER owner-only read-only audit

Source: docs/release/VAULTER_V5_RECOVERY_COVERAGE_READONLY_20261031.ps1.

This script requires the exact existing receipt ID as a parameter, refuses hosts other than VAULTER using the native machine name, and prints only sanitized metadata. It checks DPAPI receipt state/owner/ACL/ciphertext hash, original private V5 portal artwork hashes, scheduled-task identity/hash and loopback listener. It reports the limited scope of this rollback and unverified external recovery explicitly.

The script has not run on VAULTER: the currently authorized Tetherplane principal there does NOT expose process execution. Its PowerShell AST and fail-closed wrong-host rejection have been tested locally under Windows PowerShell 5.1 and PowerShell 7. No scope bypass.

Run the audit only through the existing VAULTER owner-admin terminal. Verify the downloaded script SHA-256 first. Never paste backup material, task XML, real SDDL, registry contents, user IDs, passwords or credentials into chat or a public repository.

## Remaining release gates

1. Owner-approved complete, independently encrypted backup of the actual relay/auth/portal/state/task/identity topology, with keys and authenticated integrity receipt retained separately and off-device.
2. Demonstrated restoration on a disposable Windows host WITHOUT the original VAULTER owner profile.
3. Genuine Windows installer signing and clean Store/Smart App Control acceptance from the exact reconciled source.
4. Live owner-OAuth and revision-bound Leno-only grant/negative controls, plus measured real Leno restart/reconnect and independent rollback after explicit authorization.
5. Four-device physical acceptance including RTX only when the owner declares it available.

No production auth, device, protected task, pairing, certificate, relay, or release was changed. Full Control stays NO-GO.
