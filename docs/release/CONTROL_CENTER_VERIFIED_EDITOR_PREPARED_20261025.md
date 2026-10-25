# Control Center verified-owner editor enrollment — staged, NOT YET live
Date: 2026-10-25 (Asia/Dubai)

## Exact authorized change
Owner explicitly authorized enabling the five existing audited **Control Center restriction** controls for the already-authenticated OAuth account. This is a portal-only deny/revert overlay; it cannot grant agent-local capabilities, modify the four device policies, alter relay authorization, expand OAuth scopes, or create OAuth clients.

## Observed baseline
- VAULTER previously accepted the owner-approved, read-only Control Center at numeric loopback 127.0.0.1:8791, with task `\\Tetherplane Control Center OAuth 20261024`, V3 source `5bbea29` and protected private authority journal/checkpoint/key under `C:\ProgramData\Tetherplane\ControlCenterPrivate\authority-5bbea29`.
- The prior V3 owner acceptance receipt included `CUTOVER_ACCEPTED_READ_ONLY=YES`.
- Existing `adminSubjects: []` was intentional. UI restriction controls are disabled when `isOwner === false`; the nine capability groups are read-only discovery cards.
- Protected VAULTER process execution/file access remains prohibited for this connector principal. Do not evade it through another device.

## Minimal change implemented and tested on Leno
- Source commit `6bad88c`: `GET /api/authority/:deviceId/owner-proof` accepts only the existing authenticated browser session; the registry revalidates the token and account/device pairing against the relay, then issues a five-minute HMAC-sealed signed-in subject proof. The proof itself never authorizes a restriction, discloses the access token, or edits audit/agent policy. UI adds [ Copy Verified Owner Proof ], with selectable fallback if clipboard API is restricted.
- Full repository Node suite: 55/55 PASS; standalone staged suite: 53/53 PASS; synthetic Edge QA PASS, including non-owner denial and rollback; real device policy changes: ZERO. PowerShell 5 HMAC/base64url proof interoperability tested with a synthetic signed proof: PASS.
- New private local candidate on Leno Desktop:
`C:\Users\Sohaib\Desktop\Tetherplane-ControlCenter-Editor-6bad88c-private.zip`
  - 28 manifest-verified files + manifest, 29 ZIP entries, 127480 bytes.
  - SHA-256: `120656749365b62b1fa13b797022128047bf94ac45e9c6f7068c97e2b198335b`.
  - Manifest SHA-256: `67a0c45ef5cd56ab33e5d8df8557d7a60486c64b274fa6cf78246c91929ac248`.
  - Approved original HTML: `4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8`.
  - Private font: `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e`.
- Private operator ZIP (in ChatGPT output): `Tetherplane-VAULTER-Owner-Editor-Operator-Pack-v4.zip`, SHA-256 `3f1b78c987588903215d398315881637391dff858e4627721d399efb68362d90`.
- PowerShell operator script: `Enable-TetherplaneVerifiedOwner-v4.ps1`, SHA-256 `f524650ece7e636843d65a4f1fe0d0431a0cc02fe78eee6f668affe089c26088`.
- The V4 operator script has static boundary/integrity checks; **its full Windows scheduled-task cutover path has NOT yet been executed or independently accepted**. Use read-only Inspect before Enable and preserve all output.

## Protected operator procedure
1. Manually copy private candidate ZIP Leno -> VAULTER Desktop via approved human channel, and download/extract operator ZIP on VAULTER. Do not publish private HTML/font or upload the proof to a chat.
2. In elevated VAULTER PowerShell, verify both SHA-256 hashes. Run only `-Mode Inspect`. Refuse changed OAuth/task/provenance, missing or tampered authority audit, broad ACLs, existing editor membership, or prior V4 state.
3. `-Mode Enable` uses a distinct versioned folder and preserves V3. It verifies package and source, executes standalone tests, changes only the known managed task's source path, retains the same `--oauth-config` and `--authority-config`. Browser's [ Copy Verified Owner Proof ] feature is used with the existing signed-in identity and relay pairing. The local admin verifies the proof HMAC and short expiry, then atomically backs up and changes only `adminSubjects` to the verified subject.
4. Same task restarts and must pass loopback gates; owner signs in again to confirm five restriction checkboxes and confirmation inputs are enabled. User types `ACCEPT` only after live acceptance. No real restrictions are applied by this installation.
5. On rejection or error, V4 attempts to restore the exact V3 action and empty-editor config, then verifies the original read-only listener. Preserve the previous journal/checkpoint/key and all evidence; never delete uncertain protected state.

## Historical pre-promotion gate (superseded by acceptance below)
**At the earlier staging checkpoint: code verified, private package prepared, VAULTER owner editor NOT YET ENABLED.** Production VAULTER continues the previously accepted V3 read-only version until operator runs and accepts the protected enrollment. No GitHub push/merge, no signing/release changes.

## Accepted production outcome — 2026-10-25 (supersedes the preceding staging status)

**Status: VAULTER VERIFIED OWNER EDITOR ACTIVATED AND ACCEPTED.** The earlier `NOT YET live` wording above records the state *before* this approved promotion, not the current state.

The owner provided the complete, terminal VAULTER PowerShell receipt from the corrected V4.1 operator script. Exact decisive markers:

```text
VERIFIED_PRIVATE_V4_PACKAGE=YES
PACKAGE_DIGESTS_VERIFIED=28
ACCEPTED_READ_ONLY_LISTENER_PID=2984
EXISTING_OAUTH_IDENTITY_UNCHANGED=YES
PRESERVED_AUDIT_AND_CHECKPOINT=PASS
EXISTING_ADMIN_ALLOWLIST_EMPTY=YES
V4_EDITOR_PREFLIGHT_READ_ONLY=PASS
V4_LOOPBACK_UNAUTHENTICATED_GATES=PASS
RELAY_VERIFIED_OWNER_PROOF=PASS
OWNER_PROOF_BOUND_DEVICE=Leno
VERIFIED_OAUTH_SUBJECT_FINGERPRINT=9e0355437f81b65e
EXACTLY_ONE_VERIFIED_EDITOR_CONFIGURED=YES
V4_LOOPBACK_UNAUTHENTICATED_GATES=PASS
EDITOR_SERVICE_PID=13440
V4_LOOPBACK_UNAUTHENTICATED_GATES=PASS
VERIFIED_OWNER_EDITOR_ACCEPTED=YES
```

Acceptance-specific evidence:
- Source candidate: `6bad88c`; exact private ZIP SHA-256: `120656749365b62b1fa13b797022128047bf94ac45e9c6f7068c97e2b198335b`.
- All 53 packaged Node tests passed (0 failed, skipped, cancelled); Leno's full repository suite previously passed 55/55 and synthetic Edge QA passed. The managed Control Center restarted as PID 13440 at operator acceptance.
- The operator submitted `READY` after copying a five-minute, signed relay-verified OAuth owner proof; cryptographic enrollment returned `PASS` with device bound to Leno. Only a subject **fingerprint**, not the full OAuth subject, access token, audit MAC key or proof, is stored in this document.
- The operator explicitly entered `ENROLL`; exactly one verified subject was configured. After restarting and signing in again, screenshots showed **"Verified OAuth subject approved as portal policy editor"**, five enabled restriction checkboxes, available exact device ID/reason inputs, Apply Restrictions and revision rollback controls. The audited history displayed no changes, as expected.
- The operator explicitly typed `ACCEPT` at the final acceptance prompt; `VERIFIED_OWNER_EDITOR_ACCEPTED=YES` was printed after the final unauthenticated loopback gate.
- Independent read-only Tetherplane status calls *after* operator acceptance: Surface and Leno agent 0.1.0 reported Windows x86_64 / background_only / authenticated / ready; VAULTER agent 0.1.0 reported Windows x86_64 / background_only and responded. The RTX status query in the same pass was blocked by connector safety checks, **not** counted as independently verified in that pass. Earlier RTX device status checks and the previous live four-device browser directory acceptance were recorded separately.
- No production restrictions were applied or rolled back during enrollment; **live mutation, denial and recovery behavior remain a separate acceptance gate** from the editor-UI activation. This acceptance proves the authenticated owner editor controls are active and the operator approved the cutover; it does not prove permission grants to agents.

Post-acceptance operating boundaries:
- Exactly one existing verified OAuth account may modify only **Control Center** deny/revert overlays. Native device policy, existing relay scope, OAuth client and issuer were not expanded or replaced.
- Preserve `C:\ProgramData\Tetherplane\ControlCenterPrivate\authority-5bbea29` audit journal/checkpoint/key, the prior read-only candidate and prior task-action rollback evidence. Do not reset or reprovision audit state.
- Do not display, log, chat, publish or commit the private OAuth subject, owner proof, access token, audit MAC key, owner HTML or font.
- Public GitHub promotion/merge, signed Windows installer, clean-machine onboarding, sustained cross-device recovery and live restriction mutation tests are distinct unfinished release-wide gates. **No protected merge or public release is authorized by this acceptance.**

**Disposition: the Device Authority verified-owner editor activation is complete.**
