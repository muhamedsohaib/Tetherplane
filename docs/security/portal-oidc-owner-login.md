# Tetherplane Owner Control Portal - native TetherAuth login

## Goal

Eliminate manual bearer-token copying. The browser initiates Authorization Code + PKCE S256, the existing TetherAuth issuer authenticates the owner, and the relay exchanges the code server-side. The existing OIDC authenticator verifies JWT issuer, audience, signature, scopes, expiry, subject and client. A verified canonical owner gets the existing HttpOnly portal session. Tokens are not placed into the URL, browser storage or readable cookies.

This is an isolated source candidate, NOT a deployed login feature. Current production remains in read-only token-login mode. No production OAuth registration, policy, client grant, recovery script or device agent has been changed.

## Verified provider metadata (2026-11-19)

- Issuer: https://vaulter.tailf65eba.ts.net/
- Authorization: https://vaulter.tailf65eba.ts.net/auth
- Token: https://vaulter.tailf65eba.ts.net/token
- Resource/audience: https://vaulter.tailf65eba.ts.net/mcp
- Private portal: https://vaulter.tailf65eba.ts.net:9447/portal
- REQUIRED exact new callback: https://vaulter.tailf65eba.ts.net:9447/portal/auth/callback

Read-only inspection of 24 existing OAuth client records found no registered redirect callback for this private portal. Existing HTTPS callback records belonged to ChatGPT connectors. A browser PKCE sign-in button cannot authenticate against production until this exact callback is registered.

## Separate owner authorization gate: one public PKCE client

A new dedicated **public** OAuth client (not a replacement) must be explicitly approved by the owner first. Never change existing client registrations, TetherAuth identity config, grants, private keys, or scopes without authorization.

Proposed metadata for registration review only (NOT submitted):

    {
      "client_name": "Tetherplane Owner Control Portal",
      "application_type": "web",
      "redirect_uris": [
        "https://vaulter.tailf65eba.ts.net:9447/portal/auth/callback"
      ],
      "response_types": ["code"],
      "grant_types": ["authorization_code"],
      "token_endpoint_auth_method": "none",
      "scope": "openid tetherplane:access"
    }

Use the existing supported DCR endpoint, not direct provider database edits. Verify the final client has PKCE S256 and exact redirect only, with no wildcard, no new client secret, and no extra privileges.

## Feature activation - nonsecret opt-in

After approved client registration, stage one JSON sidecar with the new client ID:

    %LOCALAPPDATA%\Tetherplane\relay\devices.json.portal-oidc-login.json

    {
      "schema": 1,
      "clientId": "<approved-dedicated-public-client-id>"
    }

The sidecar is optional. No file = original bearer login remains. If present, it must be regular (not symlinked), strict JSON, and is loaded only when the private portal is read-only, HTTPS, loopback-bound, split from the public MCP listener, with pinned public-origin proxy checks. No protected launcher changes needed.

The feature remains separate from devices.json.portal-pilot.json and all existing relay configuration. Its code never calls DCR or modifies TetherAuth state.

## Security model

1. GET /portal/auth/start creates a random 5-minute state and PKCE verifier held server-side, sets an HttpOnly SameSite=Lax state cookie (Secure on HTTPS), and 303 redirects to TetherAuth with S256 code challenge, audience, scopes and exact callback.
2. GET /portal/auth/callback requires the one-time matching cookie and state. A fixed-origin, no-redirect server-side token POST exchanges the code. The flow is consumed before the exchange.
3. The existing OIDC authenticator validates token, and canonical owner identity plus exact public client ID are required. Nonowners, client substitution, invalid/expired/replayed state, and OAuth errors fail closed.
4. An opaque HttpOnly SameSite=Strict browser session replaces manual token entry, capped at 1 hour and the signed access-token expiry. The authorization code is removed from the final URL; no token appears in DOM or browser storage.
5. Existing portal CSRF, Origin, CSP and read-only mutation denial remain unchanged. The main public relay has no portal routes.

## Local verification performed

- Focused synthetic-provider HTTP tests: 4/4 passed before final JWT-exp session hardening; rerun required after revisions.
- Windows relay full regression suite: 122/122 passed before final JWT-exp session hardening; rerun required after revisions.
- Workspace typecheck and unsafe scanner passed before final JWT-exp session hardening; rerun required after revisions.
- Headless real Microsoft Edge CDP login from a synthetic TetherAuth provider: successful PKCE owner sign-in, one exchange, 390px mobile width without horizontal overflow, no JS exceptions, HttpOnly cookie inaccessible to JS, browser local/session storage both empty.
- Synthetic test screenshots contain no real owner data or credentials.
- NOT verified: production OAuth registration, real owner login, full authenticated production browser device rows.

## Production release gates - require explicit owner authorization

1. Approve registering exactly one dedicated public OAuth client with exact private callback and no new privileges; never replace old OAuth clients.
2. Register using supported provider DCR, validate persisted metadata and client-ID result without exposing credentials.
3. Re-run source regression, authentic browser tests and security checks on the exact commit.
4. Backup the installed relay, state, Serve configuration and sidecars. Preserve hash-pinned boot-recovery launchers and all existing routes.
5. Use direct offline pnpm deploy into the canonical final relay directory. Never copy or rename an already pnpm-deployed tree: linked dependencies break.
6. Activate the nonsecret login sidecar only with a supervised rollback guard, and verify real owner UI login, four intended devices, private-portal 200, unauthorized 401, public portal 404, read-only mutation refusal, TetherAuth discovery and authenticated MCP.
7. On failure restore backup, remove the new sidecar, and verify unchanged device registration, OAuth client data and recovery.
8. Protected merge and production activation require separate authorization.

The production owner login and full device UI remain an unpassed release gate.
