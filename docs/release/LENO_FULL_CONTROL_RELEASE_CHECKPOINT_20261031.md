# Leno Full Control — isolated release-readiness checkpoint
Date: 2026-10-31 (Dubai)
Disposition: **PRODUCTION CUTOVER NO-GO**; local validation advanced. RTX is deferred at owner request.

## Exact source identity

- Workspace: C:\Users\Sohaib\source\Tetherplane-v5-leno-scoped-integration-20261031
- Branch: work/v5-leno-owner-scoped-20261031
- Original integrated candidate: 0876878029d5238a00c426548eb42983be1b90f3
- V5 local baseline: 6f03bad28a3d272d60d316f55bdccd7a027caf99
- Accepted V5 Control Center source reference from earlier handoff: 09ea09b7ba5bbe66a23851ef6f3248c799050008
- GitHub protected main verified at fc8590a7e997c01878ca4d85469d6ba8eae23882. The V5 adapters/control-center-exact/oauth.mjs file is absent on main; V5 and candidate commits did not resolve in the remote commit API. Do not attempt a merge-targeted PR until V5 source provenance and destination are reconciled.
- Exact running VAULTER relay and Control Center source/bytes have NOT yet been independently verified via owner-admin preflight.

## Evidence from current execution

1. Live authenticated ChatGPT device.status: Leno authenticated, ready and responsive; agent version 0.1.0; background_only policy. This is a real remote MCP call, not a TCP inference.
2. Leno read-only process inspection: Leno canary Running, one agent process, saved relay URL wss://vaulter.tailf65eba.ts.net:443/device, one configuration backup, isolated worktree initially clean.
3. Live authenticated device.status: Surface and VAULTER responsive; RTX most recently returned disconnected. RTX work is held until the owner releases it.
4. Initial clean rerun: relay 103/103 PASS; V5 Control Center 67/67 PASS; TypeScript typecheck PASS.
5. Added isolated synthetic regression relay/test/v5-owner-leno-restart-recovery.test.ts. Disposable relay and four synthetic paired WebSocket clients verify that Leno-only enforcement survives relay restart; exact AI client authorization and stranger denial persist; owner inspection remains read-only; other three device routes retain legacy behavior; and owner rollback is effective after the restart.
6. Post-change rerun: relay **104/104 PASS**; Control Center **67/67 PASS**; TypeScript typecheck PASS.
7. Original approved, Git-ignored V5 artwork hashes verified without distributing protected file bytes:
   - HTML SHA-256 4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8
   - Private font SHA-256 18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e
8. Local evidence: %TEMP%\tetherplane-leno-release-20261031-validation\relay-tests-postchange.log, portal-tests-postchange.log, relay-typecheck-postchange.log, artwork-hashes.log, restart-regression-targeted.log.

## Limits of this evidence

The new test verifies simulated relay-state persistence, four-device isolation and rollback. It does NOT establish a physical Windows agent's automatic reconnection after relay restart, Store signing, clean installer operation, live owner session restoration, or production rollback.

Full Control means an exact owner-approved **relay capability grant** for Leno. Device-local background-only policy, Windows ACL/UAC, human foreground consent, and provider availability remain separate gates. The live Leno browser provider was unavailable; do not claim browser control or install an unauthenticated bridge.

## Security fences

- Without the new optional authority config flag, existing routing behavior remains.
- The authority state file must already exist, be well formed and have protected VAULTER ACLs. Do not regenerate OAuth clients, credentials or pairings.
- Relay owner endpoint requires independently authenticated exact owner identity; portal proxy also requires enrolled V5 editor, valid same-origin owner session, CSRF and explicit confirmations.
- Global enforcement must remain disabled. Leno alone may appear in enforcedDevices, and only one exact observed AI client may hold a full grant at the current pairing generation.
- The owner editor has only status/capabilities read access on enforced Leno, not shell, filesystem or desktop.
- Non-Leno devices preserve legacy routing; new capabilities never inherit access implicitly.
- Rollback phrase is RESTORE Leno LEGACY ACCESS at current revision, with verified offline operator restore if portal unavailable.

## Mandatory release gates

- [ ] VAULTER owner-admin read-only preflight: capture exact active relay, auth and V5 Control Center hashes and task identities, state file ACLs, OAuth/DCR configuration fingerprint, owner identity, paired-device generations, audit/checkpoint and current listeners. Never print task arguments or bearer tokens into chat.
- [ ] Protected rollback receipt: preserve existing known-good executable paths, task actions, config fingerprints, policy/audit checkpoints, owner editor registration and current device observation; prove restore in disposable staging.
- [ ] Reconcile current GitHub main with private V5 baseline without overwriting V5. Keep original private HTML and font out of public Git and CI artifacts.
- [ ] Independently reviewed Windows packaging and isolated CI/clean-install test of candidate, using synthetic credentials; include malformed grant/denial/restart/rollback and owner-session expiry.
- [ ] Restore RTX at owner-approved availability and record fresh four-device authenticated coexistence baseline.
- [ ] Separately approve staging and activation on the exact verified production relay; stage TRUST Leno and refresh; separately ENFORCE Leno GRANTS and refresh. No global switch.
- [ ] Physically validate Leno allowed/denied operations, browser consent as independent provider, reconnect after actual relay restart, VAULTER/Surface/RTX unaffected, owner session recovery, and safe device-local stop.
- [ ] Rehearse exact current-revision owner rollback and protected offline VAULTER operator restore, then independently reverify all four devices.

No live production task, grant, policy, OAuth config, credential, pairing, service binary, GitHub branch, PR or release was altered. The isolated source-only release safeguards below were then updated.


## Follow-up: preserve current main release-security fixes (isolated source only)

- Git ancestry established a common base 5feee084eb24bfd4831ab42840bb5f10dafc8113; remote main has 2 commits unique to main while the V5 baseline has 158 commits unique to V5. A naive merge or release from this old V5 branch can miss newer CI/release safeguards.
- Restored the current main source-contract test tests/release/windows-main-publication-block.test.mjs in this isolated branch and ran it BEFORE remediation: exit 1, **1/4 PASS, 3/4 FAIL**. It caught an eleven-step legacy Windows tag workflow (including unreachable build/upload/publish commands) and missing independent release-policy CI job. This establishes a real regression gap in the V5 branch, not an observed production publication.
- Synced the exact current main fail-closed .github/workflows/release.yml: read-only contents permission, a single unconditional unsigned-release denial step, no archive, build, upload or GitHub publication steps.
- Inserted only main's independent release-policy CI job into the V5 workflow, retaining V5-specific quality, process endurance soak and Windows canary negative-contract tests.
- AFTER: source contract **4/4 PASS**, including mutation controls for job-skips, failure masking, alternate publishing, and executable commands after denial. Local cargo fmt --all -- --check PASS.
- Brought the two remaining Clippy assertion test-only differences into parity with current main; no runtime Rust implementation changed. Rust 1.99 Clippy and GitHub Windows/Linux CI have not been run against the resulting local candidate.
- The current GitHub main already contains the unsigned-release block. This synchronization is **not** a remote security fix and must not be represented as a published release.
- Evidence logs: %TEMP%\tetherplane-leno-release-20261031-validation\release-policy-fail-first.log and release-policy-postfix.log.

Source and CI are still private/local. Independent platform CI, VAULTER installed-source provenance, owner rollback receipt, RTX availability, real device acceptance, and protected cutover approval remain mandatory.