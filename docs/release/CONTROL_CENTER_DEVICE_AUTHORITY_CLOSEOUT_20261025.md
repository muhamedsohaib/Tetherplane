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
