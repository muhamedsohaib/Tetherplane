# Control Center Milestone 2 implementation plan and execution record

The user explicitly requested implementation from verified `3fde005fac9ce3048da177faaa168589c016709f`.
Use superpowers:executing-plans, strict RED/GREEN, and one independent whole-branch review.

## Design and scope

Extend the existing local portal, without a new service or authentication contract.
Approve a short code produced on an authorized device via existing `POST /pair/approve`.
Require an authenticated local session, same Origin, CSRF, explicit device-possession
confirmation, strict code format, bounded attempts and fresh upstream authorization.
Return only projected device metadata; refresh the actual account directory after approval.
Never start pairing, generate device credentials, or restart/reconfigure installed agents.
Reconnect is the existing outbound agent retry; after revocation use a fresh authorized
device-side pairing ceremony and approve its new code. There is no remote reconnect API.

Pairing records remain real registry state, not presence. Connectivity, policy and version
remain unreported because the existing HTTP API exposes none. Preserve the original logo,
ASCII frames, reduced motion, six MCP tools and device-local background_only policy.
No production auth/scope changes, OAuth clients, deployment, merge, release, money,
external messages or human-owned browser/desktop interaction.

## Review focus

- Multiple pending codes must not replace an active binding or revive an old credential.
- Expiry/logout during authorization must prevent subsequent pairing submission.
- Failed or timed-out approvals must not replay; stale directory evidence must be cleared.
- Rejection bodies, account IDs, credentials and pairing codes must not leak in responses.
- Headless browser contexts and local loopback fixtures must stay separate from installed devices.

## Tasks

- [ ] 1. RED/GREEN: registry rejects competing pending approvals and consumes sibling codes.
  Files: `relay/src/devices/registry.ts`, `relay/test/control-http.test.ts`.
  Verify real HTTP ownership and device-credential authentication before/after revocation.
- [ ] 2. RED/GREEN: protected `POST /api/pair/approve {userCode, confirmOwnership:true}`.
  Files: portal `src/{server,relay-client}.ts`, `test/{server,relay-client}.test.ts`.
  Verify auth/CSRF/Origin, possession confirmation, invalid/expired/consumed codes,
  sanitized projection, rate limit and logout/expiry races using the real RelayServer.
- [ ] 3. RED/GREEN: accessible pairing form and reconnect guidance.
  Files: portal `public/{index.html,app.js,style.css}`, `test/browser.spec.ts`, README.
  Verify real approval/revocation/re-pair, no replay, field clearing and sign-out races.
- [ ] 4. Verify recursive types/builds, focused suites, independent review, all four
  existing hosted Windows/Ubuntu CI jobs at exact feature-branch head; report live
  status failures and remaining Leno/Store acceptance gates truthfully.

## Execution ledger

- Baseline: remote feature branch exactly matches requested SHA; clean starting worktree.
- New dedicated worktree: `.worktrees/control-center-m2-20261019`, branch
  `feature/control-center-m2-20261019`. App worktree tool failed `Not a git repository`
  against the project mirror; used Git from canonical repository after ignore verification.
- Baseline portal HTTP/CLI/security suite: 15/15 passed on Node 24.19.0, pnpm 10.34.5.
- Quota: ordinary Codex usage allowed; separate Work quota unavailable through current tools.
- Read-only connector results: no-device list required an explicit ID; `Surface` returned
  `disconnected`/offline and `Vaulter` returned `capability_unavailable`/unknown.
  Neither is device execution or version evidence. No installed device was changed.
- Ruling: include the minimal registry guard because existing multiple-pending approval
  can replace an active binding, contradicting canonical remote-plane security.
  Public HTTP contracts and production configuration remain unchanged.
