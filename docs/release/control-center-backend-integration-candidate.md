# Tetherplane — source-only combined integration candidate

**Prepared:** 2026-10-23. **Status:** NOT DEPLOYED, NOT MERGED, NOT PRODUCTION-READY.

## Exact source provenance

- Base: draft PR #46 native Windows onboarding, commit `9e9bef7947f292bd8b8eda0b0dbed60fbaf18296`.
- Added without editing: exact Control Center files from draft PR #35 at `72c4e2b6714719d84166d2e8b31cf64d1fd169ad`, including `server.mjs`, `oauth.mjs`, browser behavior JS, HTTP/OAuth synthetic tests, owner-HTML verifier and installer. An existing local-only frontend on VAULTER port 8791 was reported, but it has not been read or modified during this integration.
- Added without editing: recovery guard, Pester tests and instructions from draft PR #47 at `68138090c1c447ffd5d8303d6916f00ea904cac7`.
- Reliability workflow: preserved every job and path gate from PR #46 and added PR #47's guarded recovery job and source path filters. Exact UI workflow uses the repository's already vetted checkout action SHA.
- New `adapters/control-center-exact/test/real-relay-compat.test.mjs` exercises a **genuine current relay control HTTP gateway** from this same checked-out commit, against the genuine exact portal server, on ephemeral loopback ports with in-memory synthetic accounts. It tests explicit pairing approval and CSRF, account-scoped device directory, typed revocation, device-secret invalidation and denied unauthorized or revoked device access.

## Deliberately preserved boundaries

- The approved original `public/index.html` is **not** in Git, not reconstructed from fixtures, and not redistributed. Original local asset SHA-256 must equal `36bef6cd23058fc90b0b38820fad8ac75655c89e326403160fa1e90405238a82` during later on-device visual acceptance.
- No client registrations, OAuth callbacks, issuer configuration, scopes, resource audiences, identity files, device credentials, production relay, Tailscale ACLs, Windows task, firewall, RDP session or VAULTER listener changed.
- All new tests use loopback and synthetic identities. A green workflow does **not** prove real browser OAuth, current VAULTER port state, actual four-device status, pairing on real hardware, signed packaging or reliable unattended crash recovery.

## Test contract

1. Exact Control Center Windows + Ubuntu Node tests, including the new real-relay control-plane E2E tests, at one immutable commit.
2. Existing Windows native onboarding, signing-policy, Windows/Linux quality CI, agent WS liveness and guarded recovery regression suites at that **same** commit.
3. Review any failures without disabling checks, re-registering auth clients or overwriting owner-held artwork.
4. Later controlled acceptance: same-original-HTML visual interaction, approved live browser OAuth, one authorized device pairing, authorized status/permission-denied, device revocation/reauthorization, offline/reconnect states, clean signed Windows install, rollback and independent four-device run.
5. Keep PR #35, #46 and #47 as separate draft sources; this staging branch and PR are a reproducible **candidate**, not authorization to merge/deploy.

Related mandatory release blocker: [Issue #48](https://github.com/muhamedsohaib/Tetherplane/issues/48).
