# ChatGPT OAuth edge implementation plan

Preserve six Compact MCP tools and launch-bound local policy authority.
Use an external OAuth provider for authorization-code + PKCE S256 and client registration.

1. Add failing tests for OIDC JWT validation (issuer, audience, expiry, scopes, signature, explicit subject/client identity binding), then implement using jose and trusted JWKS.
2. Add failing HTTP tests for protected-resource discovery, configured challenges, unchanged anonymous denial, six tool security descriptors and expired-token tool challenges; implement the relay edge.
3. Test and implement explicit OIDC CLI configuration while retaining static development auth.
4. Document provider setup, stable HTTPS resource, account mapping and live linking prerequisites.
5. Run complete Rust/TypeScript/E2E gates, review diff, commit and push verified feature branch. No tag or release.

Live ChatGPT linking requires a configured identity-provider tenant and public HTTPS endpoint; deterministic tests use generated ephemeral keys, never real credentials.

## Execution evidence (2026-09-24, Leno)

- Started from clean main at 6353279; created feature/chatgpt-oauth-edge.
- Red/green: missing OIDC module; missing resource_metadata challenge; missing OIDC config loader; SDK dropping top-level securitySchemes. Each was observed before its corresponding implementation.
- Relay suite: 22/22 passed; relay and complete workspace typechecks passed.
- Rust formatting, Clippy with warnings denied, and workspace tests passed.
- Complete TypeScript package tests passed except the initial Windows E2E run: browser cursor movement, desktop focus assertion and foreground-probe timeout.
- Isolated rerun passed desktop; browser cursor movement and an observed PickerHost-to-PowerShell foreground transition remained. No coexistence assertions were weakened.
- After the user confirmed Leno idle, the complete E2E suite passed sequentially: 21/21, including static and OIDC real-tetherd remote proofs, local denial, cross-account isolation, reconnect, idempotency and revocation.
- Complete workspace build, unsafe scan and git diff --check passed.
- Live provider tenant configuration and ChatGPT account linking remain deployment work; no live OAuth proof is claimed.
- Optimized tetherd build and Windows package/install/uninstall smoke passed, including SIX_TOOL_SMOKE_OK.
