# Tetherplane Control Center — Device Authority phase closeout
Date: 2026-10-25 (Asia/Dubai)
Branch: feature/device-authority-20261025
Disposition: SOURCE RECONCILED; CODE AND ISOLATED ACCEPTANCE PASS. Production promotion is separately controlled.

## 1. Requested outcome and preserved boundaries

Complete the existing five-card Control Center with a Device Authority panel, without changing the original HTML/ASCII artwork, theme and animation, the four authenticated device agents, their device-local policies, the existing OAuth issuer/client/scope, or VAULTER's current running portal. This phase does NOT cover rebuilding the Windows installer or public code-signing release.

The Device Authority overlay is deny-only at the Control Center gateway. It cannot add agent capabilities or bypass relay/device policy. Actual permission changes require a verified subject allowlist, exact device confirmation, CSRF, current revision, journal and checkpoint. An empty adminSubjects list is read-only.

## 2. Production source reconciliation — independently verified

On 2026-10-25 the owner locally collected VAULTER's read-only deployment manifest, then supplied an exact copy of the deployed server.mjs. The uploaded 20,808-byte file independently hashes to:
aa6bdab77879780aa5bf3164aba1a2b51d50df8b117fa74e68221d84cf7353b8

The isolated candidate's server.mjs can be reversed to that EXACT source by removing only:
- the AuthorityError import,
- the four-line authority enforcement block before MCP dispatch,
- the AuthorityError-to-PortalError mapping,
- and restoring one CRLF after the initial import.

The reconstructed bytes have length 20,808 and SHA-256 matching production exactly. A permanent standalone/repository Node test (test/deployed-base-parity.test.mjs) enforces this contract. There is no unknown VAULTER-only server change.

The deployed oauth.mjs SHA-256 is 4e187df4a1e9fbcca934b21064544142801b0a67401761ee8cbf18d0d13a0e29. It EXACTLY matches the preserved integration-release-audit-20261023/oauth.mjs on Leno. Candidate changes are restricted to optional AuthorityHttp initialization, routes, appended panel JavaScript and --authority-config parsing; existing discovery/PKCE, client, scope and callback logic remain unchanged.

The deployed public/tp-integration.js SHA-256 is 956e79fe108bcd16579211c54f663b042e07547fc6a61bfb91cb3da5d2735175. It EXACTLY matches the preserved staged Leno baseline. Candidate differences are uncertainty and refresh-state handling, truthful logout reporting and a server-validated HTTPS authorization destination instead of a private hostname hardcode.

The approved, owner-supplied public/index.html matches on Leno and VAULTER:
4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8
The private font public/tp-font.woff2 also matches:
18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e
Both are intentionally EXCLUDED from Git/public distribution. No artwork was rewritten.

## 3. Verified tests (isolated Leno candidate)

- npm test (full repository-aware suite): 54/54 PASS, 0 failed, 0 skipped. Includes live-compatible relay fixtures, audit restart and rollback, OAuth negatives, account isolation, owner/non-owner permissions and exact deployed server fingerprint.
- npm run test:standalone: 52/52 PASS, 0 failed/skipped. Excludes only real-relay-compat.test.mjs because that suite imports the larger repository's relay tree. The suite still runs in the full repository test job.
- npm run test:browser: PASS with headless Microsoft Edge and local synthetic authority fixtures. Panel opens; simulated restrict/rollback and non-owner denial verified; stale cross-device responses blocked; HTTP-served font matches; zero live policy edits; test loopback server terminates.
- Direct authenticated device.status checks, independently observed on 2026-10-25, succeeded for Surface, Leno, VAULTER and RTX. All reported Windows x86_64 agent 0.1.0, background_only. This confirms connector reachability, NOT production portal OAuth acceptance.
- The production VAULTER portal on 127.0.0.1:8791 was NOT replaced, restarted or modified in this phase.

## 4. Operationally safe promotion sequence — prepared, not executed

1. Verify VAULTER still serves the exact source and artwork hashes before promotion. Do not overwrite or delete the existing 20261025-approved-oauth release.
2. Create a new, isolated versioned directory with the reconciled candidate and approved private artwork in authorized protected storage. Create a SHA-256 receipt and a distinct rollback checkpoint. Keep all credentials and audit keys outside the code directory with protected ACLs.
3. Run read-only local tests and browser fixture acceptance against the candidate on an independent loopback port. No new OAuth registration or client replacement. Real browser OAuth callback is bound to the approved exact port; it is NOT valid to assume a parallel port can use that same OAuth configuration.
4. Initial live enablement should be read-only (empty adminSubjects), with fail-closed audit initialization and verified journal/checkpoint permissions. Separate approval is needed before enabling privileged portal restrictions.
5. With explicit owner authorization for protected production cutover, stop the existing managed portal cleanly using its approved supervisor, start the new version at the approved port, verify exact OAuth callback/issuer, four-device directory and read-only probes and correct permission denial. Restore prior directory/service and verify login/device status immediately if any gate fails. Do not infer success from the process being alive.
6. Only after an independent successful trial consider protected Git merge, distribution signing and broader installer rollout.

## 5. Distinct remaining release gates

The SOURCE RECONCILIATION phase is closed. These are separate deployment/production acceptance gates, not unfinished source analysis:
- Owner-authorized protected VAULTER cutover or canary operation under the existing approved identity.
- Real OAuth login, expiry, account isolation and four-device read-only acceptance in the actual Control Center, not mock-only browser results.
- Protected audit storage ACLs, operator-restoration procedure and verified rollback under real process failure.
- Public Windows packaging, trusted signing and clean-machine onboarding (a separate Tetherplane release workstream).

No production deployment, protected authentication change, OAuth registration, GitHub push or protected branch merge was performed. No real permission mutation was performed.

## 6. Handoff

Candidate source root:
C:\Users\Sohaib\source\Tetherplane\.worktrees\device-authority-20261025\adapters\control-center-exact
Reference production root:
C:\ProgramData\Tetherplane\ControlCenterReleases\20261025-approved-oauth

The privacy-sensitive original HTML and WOFF2 font must be provisioned only through an authorized local channel. The release manifest must verify them but must not publish their bytes.


## 7. Final independent acceptance stage and private transfer kit

Implementation/test commit: 5bbea29 (feature/device-authority-20261025).

The independent 28-file local stage was created from the committed adapter at:
C:\Users\Sohaib\AppData\Local\Temp\Tetherplane-ControlCenter-Final-5bbea29-20261025

Acceptance manifest SHA-256:
038f2807d3c16016eae8026e6f3f472072af3cb21cb2598a5f65c1e99c693bfb

Independent stage test command npm run test:standalone passed 52/52 with no failures/skips. The independent stage's npm run test:browser passed the actual Edge frontend, synthetic change/rollback, non-owner denial, delayed response race and exact font HTTP route; zero real policy mutations; temporary test server terminated successfully.

A private local transfer ZIP was created with 28 staged files and the acceptance manifest (29 verified ZIP entries; ZIP integrity test passed) at:
C:\Users\Sohaib\AppData\Local\Temp\Tetherplane-ControlCenter-5bbea29-private-canary.zip

ZIP SHA-256:
08cd54d28ce2ad5ee2afc7c3496b684f5e5ced7fbd17a65a9b0fdbf424b3de4c

ZIP bytes: 126027. This ZIP includes original owner-private HTML and font. It is LOCAL-ONLY for an authorized operator, NOT a public downloadable release, and must not be pushed to GitHub.

This completes source reconciliation, reproducible adapter tests and candidate packaging. It does NOT authorize a production cutover or satisfy independently tested real OAuth, OS ACL/rollback, and approved-signer gates. The current production listener and four-device identities remain untouched.

## 8. Operator-approved protected cutover — ACCEPTED (2026-10-25)

**This supersedes only the historical NOT DEPLOYED / operator gate statements above, which document the earlier pre-promotion checkpoints.**

User-approved local production cutover, exact existing scheduled task:
`\\Tetherplane Control Center OAuth 20261024`
Local loopback operator portal: `http://127.0.0.1:8791/`
Deployed candidate source: `5bbea29` on `feature/device-authority-20261025` (full documentation subsequently added at `6ef5f20`); private package SHA-256 `08cd54d28ce2ad5ee2afc7c3496b684f5e5ced7fbd17a65a9b0fdbf424b3de4c`.

**Sequence and outcome**
- Original V2 cutover passed 52/52 Node tests and preliminary listener health, but an unrelated pasted `if ($LASTEXITCODE -ne 0) {` was read as the acceptance input. The operator script correctly rejected acceptance, restored the original scheduled-task action and verified rollback process PID 10428. The later manually printed `PROMOTION ACCEPTED` was not evidence.
- V3 `InspectResume` passed: original listener 10428; correct unique scheduled task; unchanged approved OAuth client/scope; all 28 package digests verified; previous audit journal/checkpoint integrity PASS; rollback record PASS; original audit preserved. No audit overwrite or new OAuth registration.
- V3 `ResumeReadOnly` operator log: 52/52 Node tests PASS, exact HTML/font hashes PASS, `LIVE_LOOPBACK_UNAUTHENTICATED_GATES=PASS`, `CANDIDATE_LIVE_PID=2984`, `READ_ONLY_DEVICE_AUTHORITY=YES`, `PRELIMINARY_CUTOVER_HEALTH=PASS`; operator explicitly entered `ACCEPT`; subsequent loopback gates PASS; **`CUTOVER_ACCEPTED_READ_ONLY=YES`**. This is the decisive deployment receipt; the new task was not rolled back.
- Independent operator browser screenshot showed existing logged-in OAuth session on `127.0.0.1:8791`, Device Authority modal open, all four named account devices Leno/RTX/Surface/VAULTER, and successful live Leno capability discovery at revision 0. The operator explicitly accepted after the browser checks. No mutation of real device authority was performed.
- Separate read-only Tetherplane `device.status` calls after acceptance responded for **Leno, Surface, VAULTER, and RTX**. Each reported Windows x86_64, agent version `0.1.0` and `background_only` policy. Leno and Surface additionally reported `authenticated`, `ready` in detailed liveness. Do not infer more detailed transport telemetry for VAULTER/RTX than the returned receipt contains.
- No protected identity, OAuth client, relay resource/scope, device-local permission policy or original HTML/font was replaced; Control Center's authority layer is **read-only** with no approved administrator mutations.

**Phase disposition: CONTROL CENTER DEVICE AUTHORITY SOURCE/PRODUCTION READ-ONLY CUTOVER COMPLETE.** No further Control Center deployment steps are required merely to close this phase. Do not turn on privileged authorization/restriction writes as part of this acceptance.

**Still separate from this completed phase:** public signed installer and fresh authorized Windows install/rollback; independent sustained four-device soak/recovery; actual portal session-expiry and full denial behavior under production (only the documented subset of live OAuth and unauthenticated checks was evidenced). These are release-wide gates, not reasons to reopen the completed read-only UI cutover. Git remains a local feature branch unless separately approved for protected merge/release.
