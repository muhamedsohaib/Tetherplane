# Tetherplane owner permissions on iPhone — engineering gate

**Branch:** `feat/owner-portal-feedback-20261119` stacked on draft PR #150.
**Status:** isolated implementation; **not merged, deployed, or physically accepted**.

## Implemented on this branch
- Existing authenticated owner Control Portal with per-device family toggles, device profiles (Universal/Read-Only/Revoke All), operator grants/removal, emergency lockdown, and safe rollback remains intact.
- Relay mutation replies for global/incident/operator changes now include server-issued device policy revisions. The portal tracks those exact revisions and only shows **Confirmed by device** when the device is online, reports `syncStatus=applied`, `confirmedByDevice=true`, and `appliedRevision=desiredRevision`. Errors and superseded revisions are distinct.
- Accessible, capped text-only toast notifications (pending, confirmed, rejected) including iPhone safe-area spacing and dismiss buttons. No raw HTML, no credential-bearing messages.
- Explicit, opt-in **live page alerts** for passive policy changes made in another session. Action feedback remains always on. Sign-out clears in-memory state.
- `/portal/manifest.webmanifest` and a Home Screen manifest link for a standalone iPhone/Android shortcut; this introduces **no** service worker, push subscription, new identity mode, or authentication bypass.
- No browser `localStorage` or `sessionStorage` for owner secrets; all existing cookies/CSRF/origin checks are unchanged.

## Not yet shipped
- **Native iPhone background push:** not implemented. iOS requires a supported HTTPS Home Screen web app, user-gesture opt-in, service worker/Push API, per-account subscription storage, server-side VAPID-enabled sending, and real-device delivery proof.
- Device-native notification delivery after closing the page: not implemented. Page toasts are visible only while the portal is open.
- Face ID/passkeys, removal of owner bearer-token entry, and installation/onboarding UX beyond the manifest: not implemented.
- Physical iPhone Safari and Android Chrome G6, live fleet policy change and real delivery confirmation: not accepted.

## Real-world release acceptance
1. Review and approve a staging-only HTTPS origin, deployment interface and operator test identities. Do not expand existing live device scopes as a shortcut.
2. On iPhone, open trusted HTTPS `/portal`, add it to Home Screen (standalone mode), authenticate via the existing approved owner flow.
3. In a synthetic/staging device first: Grant one capability, verify **Pending** followed by agent-confirmed version, independently test allowed action. Revoke it, verify **Pending** then **Confirmed**, independently verify `permission_denied`. Also test denial and offline sync and security audit.
4. Repeat on Android Chrome with real touch and checked viewport behavior.
5. Implement background Web Push in a separate security-reviewed gate before advertising iPhone system notifications. Require explicit permission, device-specific subscription revocation, rate limits, owner-account isolation, no secrets in push payloads, and physical receipt/opt-out proof.
6. Confirm rollback, sign-out, no unapproved background delivery, and unchanged production agents/OAuth/DCR.

**Do not merge or deploy this branch without owner approval.**
