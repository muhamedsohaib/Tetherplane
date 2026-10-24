# Owner identity and device-grant acceptance gate

Date: 2026-10-24. Draft review only. **Do not deploy to VAULTER, activate enforcement, change OAuth/DCR registrations, or publish a release from this document.**

## Evidence and identity boundary

- Historical owner-authenticated VAULTER Control Center acceptance (2026-10-20) reported a dedicated **existing** OAuth client registration, separate from ChatGPT, with the existing stable Tetherplane issuer and loopback Control Center callback. This is a historical observation, **not** a fresh reading of its current live client database or the owner grant config.
- On 2026-10-24 a read-only HTTPS OIDC discovery request from an authenticated Surface device returned HTTP 200, correct expected issuer, auth/token/JWKS endpoints and PKCE S256. This establishes active issuer metadata, not which clients are registered or logged in.
- The draft relay can bind a **separate management identity** using `--authority-config` with exact `owner.accountId`, `owner.clientId`, `owner.principalId`, and a protected absolute grant-state path. Only an authenticated client matching all three can administer grants. The **same person/principal in the ordinary ChatGPT OAuth client is not the owner manager**.
- **Live management identity NOT YET VERIFIED.** No authorization, configuration file, process arguments, tokens, private keys or grants were read from VAULTER; its Tetherplane principal does not expose process or browser control. Do not evade that boundary.
- The opt-in authority defaults to `enabled:false`; the presence of a registered OAuth client or a green test does **not** imply enforcement is active.

## Proposed minimum viable access matrix (not owner-approved)

For **existing authenticated client IDs** once they are read from the owner-authorized relay directory and paired devices. All principal IDs are exact; do not substitute conversation names, actor labels or tokens.

| Client identity (exact ID to verify) | Leno | Surface | VAULTER | RTX |
| --- | --- | --- | --- | --- |
| Existing dedicated Control Center management OAuth client | Observe | Observe | Observe | Blocked/ungranted |
| Existing primary ChatGPT OAuth client | Operate | Observe | Observe | Blocked/ungranted |
| Any other currently registered Codex/OpenCode/third-party client | Blocked/ungranted | Blocked/ungranted | Blocked/ungranted | Blocked/ungranted |
| Unrecognized client, principal or account | Blocked/ungranted | Blocked/ungranted | Blocked/ungranted | Blocked/ungranted |

Rationale: Leno is the current supported browser/engineering canary. Surface remains the operator command center and VAULTER carries the relay/identity infrastructure; both should default to Observe. RTX has never accepted a current signed first installation and cannot acquire a grant before authorized pairing. This template is NOT a statement that the owner has approved these choices.

`Operate` in this candidate means scoped file/browser/job actions **without unrestricted `process.run` or `process.input`**, no `process.terminate`, no physical pointer or privileged foreground control. The device's local policy and actual provider availability are still independent, stricter gates. Explicit grants are never sufficient to override the device policy.

## Proof required before **any** real enforcement change

1. In the existing VAULTER Control Center, use its **already registered** owner OAuth client; do not create a new one. Confirm the approved issuer and callback without revealing a token or client secret. An owner-authenticated `GET /api/authority` must return HTTP **200** with `enabled`, `revision`, and the grant list. A normal ChatGPT OAuth session with the same account must get **403** from management. `503` means owner authority is not configured on that relay. `401` means unauthenticated/expired. A 200 from OAuth discovery alone is not enough.
2. Independently verify the *effective* running relay has loaded the intended exact `owner.accountId + clientId + principalId` via `--authority-config`; verify the owner client is the existing approved Control Center registration, distinct from the ChatGPT client. Handle the protected configuration locally, print ONLY booleans and revision/count summaries. Do not paste JWTs, arguments, client secrets or file contents into chat.
3. Record authoritative paired `deviceId` and `pairedAt` for Leno, Surface and VAULTER. RTX stays ungranted until its separate first-install and pairing acceptance. Record correct OAuth client ID and principal ID through authenticated account metadata, **never inferred from a chat title**.
4. Owner reviews/edits the proposed table and explicitly approves the **exact** assignments. Stage all intended grants using a revision check and inspect the returned snapshot. Do not activate if any intended client/device lacks an explicit entry.
5. In a **disposable/staged** instance using existing approved identities, perform observe/operate allow and deny tests, same-user different OAuth clients, unknown principal, batch-child denial before dispatch, ACL path denial, browser-unpaired denial, reconnect, simultaneous device sessions, persistence and revocation/re-pair protection. Never retry uncertain mutations automatically.
6. Only in an authorized maintenance window, with an independently tested rollback and trusted-signed build, let the verified owner type `ENFORCE DEVICE GRANTS` to activate. Verify the required `device.status` requests survive, refused calls are denied before device dispatch, and no OAuth/token changes occurred. Rollback requires the **same owner identity** and exact `RESTORE LEGACY ACCESS`, plus independently checked status and revision. No autonomous privilege expansion.
7. Separately accept a trusted-signed clean Windows kit, extension-offline first boot, logon/reboot and restart recovery, state-preserving rollback, real RTX first install under approved custody, and complete four-device good/denied-operation evidence. Passing CI is not distribution readiness.

## Synthetic identity-enforcement acceptance (no real OAuth registration)

`relay/test/owner-authority-oidc-acceptance.test.ts` uses temporary RS256 test keys and an in-memory OIDC identity strategy, real relay owner-management HTTP handlers, the device router and synthetic acknowledged devices. It intentionally uses a **common subject/account/principal for the owner portal and ordinary ChatGPT** but different verified OAuth client IDs. It tests typed enable/disable, revision mismatch, scope/audience denial, distinct management identity, missing/unpaired RTX grant refusal, Observe vs Operate matrix, denied direct and batch process calls never dispatched, grant revocation, explicit legacy rollback, and state persistence. No real user client, device credential or production environment is touched.

## Current outcome / stop criteria

- Source candidate: [PR #57](https://github.com/muhamedsohaib/Tetherplane/pull/57), draft and unmerged; exact-head CI must pass after each test/review update.
- Read-only connector snapshot: Leno, Surface, VAULTER authenticated/responsive, agent `0.1.0`; RTX disconnected/uninitialized. This does not verify installed source commit or trusted signature.
- Owner binding and **live** grant enforcement acceptance: **NOT PROVEN**.
- End-user release: **NO-GO** until trusted signing, owner management identity verification, stable four-device operation and independently observed rollback.

Keep the original four-device architecture and protected OAuth/DCR/scope boundaries; do not register replacement clients, bypass the local policy broker or modify production identity settings for a narrow permission issue.
