# Device Authority phase — concise closeout and final integration gate
Date: 2026-10-25 (Asia/Dubai)
Branch: feature/device-authority-20261025
Code HEAD at stage creation: 1606814b3da611422662ddc6235cfb3051ac241b
Release: NOT DEPLOYED / NO PROTECTED MERGE

## Scope decision
Complete the already-built Device Authority Control Center panel, preserve VAULTER's approved live OAuth/relay and five-card UI, and reconcile exact deployed server behavior before promoting. Stop unrelated signing/onboarding work until this specific front-end integration is resolved. Do not alter the protected auth boundary, the agent's policy, or the four-device architecture.

## Current facts
- VAULTER owner-produced read-only receipt: deployed at C:\ProgramData\Tetherplane\ControlCenterReleases\20261025-approved-oauth, 127.0.0.1:8791, node.exe PID 5016 at receipt time. A process executable hash is not proof of loaded source.
- The live approved HTML is an exact hash match with candidate: SHA-256 4e5a9de9bb4444b06522085a73268a8a8940664f27ff44e9bd76637791b6a9f8.
- Private font also matches: SHA-256 18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e. Both remain excluded from Git and public distribution.
- public/tp-oauth.js hash also matches: d6eed7795247417d13e472aba88c39076ab7883e042080aa1571b246b90a4195.
- Exact deployed oauth.mjs hash 4e187df4a1e9fbcca934b21064544142801b0a67401761ee8cbf18d0d13a0e29 matches recoverable older Leno integration worktrees. The isolated candidate adds optional AuthorityHttp and authority routes.
- Exact deployed tp-integration.js hash 956e79fe108bcd16579211c54f663b042e07547fc6a61bfb91cb3da5d2735175 matches the earlier preserved local staging baseline. Candidate changes handle uncertain status/directory/signout and remove an owner-specific OAuth-host hardcode.
- Deployed server.mjs hash aa6bdab77879780aa5bf3164aba1a2b51d50df8b117fa74e68221d84cf7353b8 is NOT present in 18 checked Leno worktrees or the five distinct committed versions in local Git history. Candidate server.mjs hash bd41f7cf13544e637ab4d3b1bc521f6f902a4784f39db951569a913b98fad2ec. Its production-specific source differences remain UNKNOWN.
- The authority modules and frontend panel are absent from live VAULTER (expected for previous release). They are implemented in isolated candidate, not deployed.

## Verified isolated tests
- Previous source checkout: 53/53 Node tests passed; headless Edge mock-restriction, rollback, non-owner denial, stale-response race and actual font HTTP route passed. No real device-policy mutations.
- New separate local stage C:\Users\Sohaib\AppData\Local\Temp\Tetherplane-ControlCenter-Acceptance-1606814 has 27 files and manifest SHA-256 ab2cbaea062e118c642e533efd58628838ec07312d18e55ec6c029d04e2f2a02. It is NOT a signed/distributable release and includes private visual assets for local acceptance only.
- The first standalone Node run passed 51 tests but exited 1 because real-relay-compat.test.mjs imports the full repository relay source tree, which is intentionally absent from the self-contained stage. This is a packaging/test-selection mismatch, not a proven runtime defect. Stage artwork verification passed. Do not report a clean standalone suite until retested explicitly excluding repository-coupled tests.
- A second standalone run excluding the repo-coupled suite was launched; no completion receipt was retrieved. It is NOT counted as passed.
- Four existing authenticated agents were responding previously (Surface/Leno/VAULTER/RTX, agent 0.1.0, background_only). Status alone is not live Control Center OAuth acceptance.

## Exact integration gate (single missing input)
The owner copied the deployed server to VAULTER Desktop and verified its SHA-256 equals aa6bdab77879780aa5bf3164aba1a2b51d50df8b117fa74e68221d84cf7353b8. The limited remote Tetherplane principal cannot read that Desktop path (permission_denied). Do not bypass that boundary.

Receive that already-created 20,808-byte 'vaulter-deployed-server-20261025.mjs' as an ordinary chat attachment, or through a user-approved source-sharing channel. Inspect for credentials before sharing. Then:
1. Read and compare the exact deployed source to the candidate and known older base. Preserve deployed-only fleet/OAuth/route behavior.
2. Implement a minimal source-level merge in the isolated worktree; leave the runtime untouched.
3. Run 53+ repo tests, actual locally staged Node/Edge tests against merged code, verify visuals and the four-device discovery behavior where authorization permits.
4. Produce an immutable stage manifest and exact rollback copy instructions; ask explicitly before protected VAULTER port-8791 promotion or protected Git merge.
5. After owner-approved controlled promotion, verify OAuth session expiry, allowed/denied operations, device directory, rollback and four-device connectivity. Only then mark phase deployed.

## Boundaries
No independent signed Windows installer, clean-machine onboarding, or production OAuth-authenticated Device Authority behavior has been accepted yet. Do not misrepresent synthetic tests as production acceptance or automatically create new OAuth clients. No remote VAULTER source files, auth, identities or live permissions were changed during this reconciliation.
