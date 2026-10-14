# Tether-auth browser acceptance and migration checkpoint

Date: 2026-10-14
Execution target: Vaulter (temporarily authorized by user), never Surface/RTX.
Starting point: recovery branch `fix/oauth-dcr-scope-recovery-20261014` at `4dbe174`.

## Goal
Make the already implemented, self-hosted `tether-auth` suitable for actual browser-driven login and explicit OAuth consent, then stage it alongside the current Auth0-based relay. Preserve device pairings, the six-tool MCP contract, and local authority.

## Verified constraints
- Remote Desktop Commander hosted tool is over account quota; do not retry it or confuse it with free `@wonderwhy-er/desktop-commander`.
- Free Desktop Commander is local stdio MCP. It needs a separately configured, authenticated remote transport to be callable from ChatGPT web; exposing unauthenticated filesystem/shell capability via Tailscale Funnel is prohibited.
- Composio's two existing Tetherplane connections return `Authentication required`. Neither provides remote command execution today.
- Current `tether-auth` has JSON device-login and consent endpoints but no browser HTML interaction; preserve these JSON contracts.
- Live Vaulter remains uninspected, and Leno's live authenticated device RPC remains unproven. No claim of deployment readiness is allowed before live acceptance.

## TDD feature sequence — browser interaction
1. RED: tests request `Accept: text/html` and assert an escaped, no-store login page with a code, explicit submit and CSRF protection.
2. RED: tests request consent HTML, verify explicit resource/scope presentation, escaped client metadata, and that GET never authorizes.
3. RED: native form submission rejects missing/invalid CSRF and accepts the correct interaction-specific token. JSON APIs remain compatible.
4. GREEN: add minimal server-side HTML without third-party JS/CSS, no tokens/cookies in HTML, strict CSP and same-origin POST forms.
5. GREEN: approved forms follow the OIDC provider's redirect; pending login stays pending without minting a grant.
6. Verify Linux/Windows typecheck, tests, builds, and complete repository CI; independent source review before acceptance.

## Vaulter deployment sequence — not authorized for speculative disruption
1. Obtain working Vaulter execution (existing secure shell or locally installed free MCP); do not bypass the exhausted hosted subscription.
2. Read sanitized service, listener, proxy, task, repository and port state; snapshot existing configuration and identify the paired account ID without outputting secrets.
3. Stage `tether-auth` as a separate loopback-bound process using stable HTTPS issuer, file-backed SQLite, protected JWKS, private bridge credential, and trusted TLS proxy.
4. Test /readyz, issuer discovery, JWKS public keys, DCR/PKCE S256, device-assisted login, consent, and token claims.
5. Before the live switch, obtain approval for identity-provider cutover and any changes to public routing. Preserve an immediate rollback to existing Auth0.
6. Change only the relay OIDC verifier and protected-resource issuer; do not change audience, the existing device account, or local policy.
7. Verify ChatGPT's 6-tool discovery and authenticated read-only status from Leno, followed by a denied outside-root operation.
8. Only after stable real-world acceptance, retire the Auth0 rollback in a separately approved change.

## Acceptance
- Real browser completes device approval and consent.
- ChatGPT receives the resource-scoped bearer and discovers exactly six tools.
- Device status succeeds for the existing paired account without privilege expansion.
- Relay rejects invalid signature, scope, audience, subject and client.
- Rollback plan and observed Git SHA are documented.
