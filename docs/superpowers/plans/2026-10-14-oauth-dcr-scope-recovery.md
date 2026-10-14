# OAuth DCR scope recovery plan

**Goal:** Restore verified Composio `device.status` for Leno and document repeatable, least-privilege enrollment when OAuth clients are dynamically registered.

**Architecture:** Keep relay RS256, issuer, audience, time, scope and exact subject/client binding checks. Diagnose authorization request, issuance, forwarding and binding separately. An optional Auth0 Post Login Action adjusts target scopes before provider authorization and consent; it never force-adds token scopes or enrolls clients automatically.

**Canonical sources:** the 2026-09-17 design, implementation roadmap and local-core plan; `docs/remote/chatgpt-oauth.md`; the 2026-09-26 auth production A3 plan.

## Constraints

- Work on Leno; Vaulter inspection was additionally authorized read-only. No Surface or RTX access.
- Preserve pre-existing staged changes and release bundles. No credentials, JWTs, authorization headers or full claims in output, fixtures or Git.
- No blind reconnect, DCR request, relay restart, grant expansion or wildcard identity binding.
- Keep six tools, background_only, existing paired account and local Policy Broker authority.

## Evidence and recovery

- [x] Inspect status, branch, last five commits and remotes; read canonical documents.
- [x] Reproduce the failure independently for both existing active Composio accounts.
- [x] Inspect scope and binding gates; compare with current official Auth0/MCP documentation.
- [x] Probe public resource metadata, challenge, health and readiness from Leno.
- [ ] Read sanitized live authorization scopes/resource, per-client user grants, deployed Action, and verified bearer denial category. Check the actual client claim against loaded binding, retaining the paired account. SSH is presently denied and the task Auth0 browser requires sign-in.
- [ ] Determine one evidenced minimal live change, obtain required approval, apply it once, then verify the existing connection without creating another client unnecessarily.
- [ ] Prove an authenticated `device(op=status, device=Leno)` result from Composio. Readiness, DCR/login/exchange success and anonymous discovery do not satisfy this gate.

## Reviewable Action example (local preparation)

Files: `auth/examples/auth0-target-scope.cjs`, `auth/test/auth0-target-scope.test.ts`, `docs/remote/auth0-dcr-scope-recovery.md`.

Interface: `exports.onExecutePostLogin(event, api)` reads operator-configured `TETHERPLANE_RESOURCE` and `TETHERPLANE_BINDINGS_JSON` from Action secrets. Bindings are metadata containing exact `subject` and `clientId`; no tokens or client secrets. Match `event.resource_server.identifier`, `event.user.user_id` and `event.client.client_id`. Use only `api.transaction.addTargetScope('tetherplane:access')` for an enrolled pair. Preserve all other target scopes. For the configured resource, malformed enrollment, unenrolled identities, unsupported flows or an unavailable target-scope API fail closed. Other resources are unaffected. Do not fall back to `api.accessToken.addScope`.

- [x] Write behavioral tests first using synthetic event metadata and an Auth0 API boundary double. Catch wrong resource, subject/client mismatch, malformed configuration, wildcard enrollment, existing target scope, missing target-scope method and unsupported flow.
- [x] Observe the expected RED result before implementing the example.
- [x] Implement minimum handler, observe GREEN and typecheck/build the auth package.
- [x] Independent review; run repository gates that comply with the background-only contract. Explicitly identify excluded foreground/clipboard acceptance tests.
- [x] Commit only recovery files and push the verified feature branch. Leave unrelated index entries intact.

## Durable enrollment design

Prefer a supported stable OAuth client registration when available. For DCR, operator enrollment records an exact trusted client ID, exact subject, existing account/principal, exact resource and sole allowed API scope. Verify client metadata and redirect URI independently; names and the `tpc_` prefix confer no trust. Ensure the Auth0 user-delegated per-client grant, Action enrollment and relay binding agree before a new session. Registration scope is allowable client metadata, not proof of a requested or consented scope. Explicit resource selection is required through authorization and exchange. Retire old enrollment only after a successful new-session proof and explicit revocation authorization.

Review focus: scope injection to unrelated clients/resources; stale DCR identity; missing/unsupported Auth0 API; consent/grant filtering mistaken for token issuance; successful issuance mistaken for bearer forwarding or relay authorization. The Action tests cover local guards only. Tenant grant filtering, consent and complete live forwarding remain acceptance work.
