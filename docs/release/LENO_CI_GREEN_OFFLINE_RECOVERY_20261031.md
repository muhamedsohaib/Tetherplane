# Leno Full Control — verified CI and synthetic offline recovery checkpoint

Observed: 2026-10-31 (Dubai UTC+4). Release decision: **PRODUCTION CUTOVER NO-GO**.

## Independently verified Windows/Linux CI

- Public CI-only branch: ci/leno-v5-owner-20261031
- Exact tested SHA: 6168a81519a73a054dcb81061cf34081cfc552e1.
- Windows acceptance: https://github.com/muhamedsohaib/Tetherplane/actions/runs/41215755258 — **3/3 jobs passed** (native Windows MSVC build, onboarding/signing policy, Leno authority, ACL and native task ownership).
- Main CI: https://github.com/muhamedsohaib/Tetherplane/actions/runs/41215755229 — **3/3 jobs passed** (Windows and Ubuntu).
- Onboarding/signing suite: **147 passed, 0 failed, 0 inconclusive**.
- Relay tests: **105 passed**; V5 Control Center: **67 passed** in both CI environments.
- Disposable **unsigned** Windows tetherd.exe SHA-256: 71d0fdfc1717a995ee1f6910978573b9efe80005835afb5b35d2f0b9e3213ca8. NOT a signed/Store-approved binary.
- Vercel returned **zero preview deployments for the CI branch**; branch-specific exclusion does not disable other previews.
- Original isolated release candidate SHA before this checkpoint: 897aa7337fab4a20ac197212e8d3f502b4c06fa0. The CI branch includes additive changes and is NOT identical to the release branch.

## Synthetic offline recovery test

Source: tests/release/v5-offline-recovery-synthetic.ps1.

- Windows PowerShell 5.1: PASS; PowerShell 7: PASS.
- Portable ZIP contains **11 entirely synthetic files**: simulated relay, auth, V5 portal, placeholder (NOT approved) artwork, three inactive Task Scheduler XML files, four simulated device registrations, legacy Leno owner policy and audit checkpoint.
- Archive entries and their SHA-256 values are verified against a separately pinned immutable manifest **before** the restore destination is touched; output files are checked again afterward.
- Corrupted relay content: rejected before restore. Traversal and extra ZIP entry: rejected before restore. Disposable root: deleted with zero leftovers.
- No production task registration, live service restart, DPAPI, OAuth, credential extraction, policy grant or actual-device operation.

This proves only synthetic package-restore mechanics. It does NOT prove a usable actual VAULTER backup, protection of live secrets, off-host recovery, profile-loss recovery, real Task Scheduler restoration or production availability. Do not use this synthetic ZIP for actual production recovery or fill it with real secrets.

## Mandatory next release gates

1. **Off-device owner-controlled recovery:** owner-admin verification of currently running VAULTER source hashes, task identities, actual config/registry/audit fingerprints and current pairing. Preserve encrypted recovery material under owner control, outside ChatGPT/Git/CI. Demonstrate restore to a disposable Windows staging machine without relying exclusively on the VAULTER DPAPI profile.
2. **Actual signed Windows package:** reconcile protected main and private V5 source, preserve unsigned-publication fail-closed guard, provision legitimate signer, verify authenticode/Store-signed installation, update and rollback and Windows 11 policies. Unsigned CI is NOT a release artifact.
3. **Real V5 OAuth owner acceptance in protected staging:** verify enrolled owner, CSRF, session expiry and recovery, exact observed client, denied unauthorized operation, revision-bound staging, Leno-only enforcement and independent rollback.
4. **Owner-approved Leno production canary:** only after explicit authorization for any real relay restart, scope grant, task change or cutover. Recheck device-local background_only policy, ACL/UAC boundaries and no false unrestricted-control claims.
5. **Four-device coexistence:** verify Leno, Surface, VAULTER, and RTX only when the owner separately confirms RTX is free; test reconnect, denials, rollback and device-local stop.
6. **Explicit cutover/rollback:** stage TRUST Leno, refresh and verify; separately ENFORCE Leno GRANTS, refresh and verify; independently demonstrate RESTORE Leno LEGACY ACCESS and off-device operator recovery.

Live Leno still runs agent 0.1.0, background_only; no production Full Control grant or auth mutation was performed.
