# Tetherplane account recovery and authenticator enrollment (design)

**Status:** Draft design only. **Issue:** #29. **Date:** 2026-10-20.
**Reference implementation:** combined OAuth candidate `fb4614c5192f8dc2d4f09a57b2ab6e2eaa21c70c`.
No issuer, relay, signing-key, OAuth-client, local-device, or production policy changes are made by this document.

## Do not confuse recovery categories

- **TetherAuth infrastructure recovery:** Restore runtime code, coherent SQLite OAuth state and signing-key continuity after deployment failures (issue #30).
- **Individual Tetherplane account recovery:** Restore access when a person loses an authenticator. **Never** restore the production OAuth database just to recover a user's account.
- **Google Authenticator:** Generates RFC 6238 time-based codes in the app; it does not email codes. Tetherplane must operate its **own** separate verified-email recovery-code flow. Google Authenticator sync, if the user enables it, is user-controlled.

Never hardcode an operator's email address as the default for all users. Each subscriber must verify and manage **their own** recovery email and have another independent recovery option.

## Identity boundary / placement

Current `auth/src/interaction.ts` calls `RelayDeviceLoginProofClient.consume()` and receives a trusted `accountId`. Current `relay/src/auth/login-proof-http.ts` approves the interaction based on authenticated device credentials and a time-bound user code. No built-in MFA or human-signup flow has been verified. OAuth dynamic client registration (DCR) is **not** human account signup.

Introduce a distinct account-security state store keyed to the **verified, server-derived accountId**, not to a caller-supplied email or OAuth client ID. Require the correct user-authenticator assurance on the trusted device-login approval/consumption path **before** `interactionFinished` can authorize a normal login. Bind each assertion to the account, interaction, client, nonce, time and verified device context. A response body or fake relay claim must not bypass it.

Preserve `tetherplane:access` as a **resource-specific** `/mcp` permission, existing issuer/audience, DCR registrations, local Policy Broker scope/denial enforcement, all six MCP tools, and the four-device architecture.

## New-account state machine

| State | Allowed action | Transition |
| --- | --- | --- |
| `pending_email` | Minimal verification enrollment; no normal MCP grant | Unique email ownership verified by expiring single-use challenge |
| `pending_authenticator` | Enroll TOTP or specifically approved equivalent | Fresh TOTP challenge succeeds; seed secured and bound to account |
| `pending_recovery_setup` | Present saved codes securely, enroll extra address | Codes stored by user and confirmed; second channel verified when required |
| `active` | Normal device-assisted OAuth login and consent | Meets session assurance and risk-based step-up |
| `recovery_pending` | Rate-limited recovery, not privileged MCP access | Two independent recovery mechanisms or applicable verified re-proofing |
| `suspended` | No new authorization | Audited, explicitly authorized remediation |

Pre-existing production users require an **independent migration** with lockout protection, not a silent policy flip. New-user enforcement is an onboarding release gate, not a prerequisite to deploying a narrow OAuth metadata repair for existing clients.

## Authenticator and recovery-code security

1. **Google Authenticator-compatible TOTP:** CSPRNG secret per account, RFC 6238 validation, enrollment QR and manual setup, mandatory confirmation code, encryption of seeds at rest using separate managed keys, bounded clock skew, anti-replay and throttled attempts. Permit additional passkey/WebAuthn authenticators for stronger phishing resistance.
2. **Saved recovery codes:** CSPRNG codes >=64 bits each, delivered only during the authenticated protected setup/regeneration session, stored as salted hashes, consumed atomically exactly once, rotated after use/reissue, with independent notification. Never email an entire permanent recovery-code set, log plaintext, or put it in a backup receipt.
3. **Email-issued codes:** Only to the **subscriber's verified recovery address**, with a new transaction-bound code, single use, cryptographically strong randomness, expiry (target 10 minutes), rate limits, generic non-enumerating responses, audit and independent security notification. Email is a **recovery mechanism**, not a general second-factor login bypass.
4. **Assurance:** For an AAL2 recovery goal, require two recovery methods from different classes or one recovery method plus a still-bound authenticator, or appropriate re-proofing. Provide secondary recovery addresses/channels; changing addresses/authenticators requires authenticated step-up and notifications.

## Security and CI acceptance

- Positive end to end: signup -> verify email -> confirm authenticator -> securely save recovery codes -> authenticate on a trusted device -> normal OAuth resource-specific consent -> six MCP tools and existing local denials unchanged.
- Negative: skip enrollment, wrong/expired/replayed TOTP, reused saved or emailed codes, email enumeration, replay/cross-account/cross-interaction proof, malicious client metadata, stolen session, lost-phone recovery, compromised email, delayed notification and simultaneous recovery races.
- Deterministic tests on Windows and Ubuntu. Fake mail transport only in CI; no live emails, real Google enrollment or private signing keys in fixtures.
- Migration fixture made by a genuine prior runtime; schema/state compatibility and rollback. Independent security review, operator approved rollout, meaningful audit receipts.
- Do not launch public new-user onboarding without independently verifying recovery enrollment and successful loss-of-device recovery.

## Supporting references

- `auth/src/interaction.ts`, `auth/src/relay-device-login.ts`, `relay/src/auth/login-proof-http.ts`, `auth/src/sqlite-adapter.ts` (inspected at the combined OAuth candidate).
- NIST SP 800-63B-4, account recovery: https://pages.nist.gov/800-63-4/sp800-63b.html
- Google Authenticator app: https://www.google.com/mobile/authenticator/

**Implementation and deployment remain pending. No personal email verification, MFA enrollment, recovery code generation or live account mutation was performed.**
