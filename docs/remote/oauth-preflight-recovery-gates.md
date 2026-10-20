# Read-only OAuth metadata preflight and reversible recovery gate

## Purpose

A successful \`/healthz\` or \`/readyz\` response **does not** prove that
ChatGPT can complete OAuth or that any particular device is authenticated.
Run this preflight to catch known public issuer, metadata and scope routing
problems *before* presenting another device-login challenge.

The exact protected OAuth issuer is
\`https://vaulter.tailf65eba.ts.net/\` (trailing slash retained).
The only canonical MCP resource is
\`https://vaulter.tailf65eba.ts.net/mcp\`.
The resource-specific permission is \`tetherplane:access\`.

## Read-only operator command

From a trusted local checkout containing the reviewed script, with Node 22+:

\`\`\`powershell
node .\scripts\oauth-public-contract.mjs
\`\`\`

No arguments, device credential, OAuth code, account ID or administrator
permission is needed. The script performs **exactly three GET requests**
over HTTPS to the pinned Vaulter origin:

- \`/.well-known/openid-configuration\`
- \`/.well-known/oauth-protected-resource/mcp\`
- \`/jwks\`

It forbids redirects and checks the exact issuer string, metadata links,
PKCE S256, presence of RFC 9207 issuer-response support, absence of
resource permissions in general OIDC scopes, canonical resource-scope
registration, and publication of public (not private) signing keys.

Exit code 0 / \`PASS\`: Public metadata is internally consistent at check
time. This is a **necessary, not sufficient** condition for OAuth acceptance.

Nonzero / \`NO-GO\`: Halt fresh ChatGPT reconnects. Diagnose metadata
routing or the deployed version; do not re-pair devices or overwrite clients.

**As of the original 2026-10-20 investigation, the deployed server still
advertised the duplicate general OAuth access scope, until a separately
authorized release of the one-line provider fix.** A preflight failure on
that known defect is expected; it does not justify weakening the check.

## Independent regression evidence

\`node --test scripts/test/oauth-public-contract.test.mjs\`

Nine synthetic tests verify exact-origin and trailing-slash mismatch,
canonical resource authorization-server binding, unknown permissions,
general-versus-resource scope duplication, PKCE and advertised endpoints,
no private JWKS publication, redirect rejection, network failures, and
GET-only behavior without credentials or callbacks. Tests run on Windows
and Ubuntu. No production calls are made in CI's synthetic tests.

TetherAuth provider integration tests in the separate
\`test/oauth-issuer-rfc9207-20261020\` branch complete two isolated real
authorization flows with PKCE, consent, exact \`iss\`, and signed JWT claims
for the canonical resource. Their synthetic success does not establish
what issuer is stored inside ChatGPT.

## Controlled production acceptance (requires separate explicit approval)

The isolated OAuth fix is deliberately not deployed as part of this
preflight. Before deploying **any** approved TetherAuth build:

1. Record exact branch/commit and hash of the existing service artifact,
   service startup arguments **without revealing credentials**, bound
   address, public issuer and resource metadata, and current Vaulter
   and Surface authenticated \`device(status)\` results.
2. Establish a verified rollback artifact from the *current* running
   build and a tested, secure online SQLite backup with WAL/SHM
   consistency. Protect JWKS and bridge credentials; do not export them
   to PRs, logs, chat, shell histories or temporary public files.
3. Verify the targeted change is the single provider scope declaration;
   verify code-review approval, exact-HEAD auth/relay/denial tests,
   Windows/Ubuntu CI, and no unrelated authentication changes.
4. During an approved maintenance window, deploy only the reviewed
   TetherAuth change, reusing original issuer, resource, JWKS, persisted
   DCR clients, refresh grants, bridge token and four device identities.
   Do not deploy a replacement OAuth issuer or grant broader scopes.
5. Require a **passing live preflight**, then initiate exactly one
   consent-based ChatGPT authorization using an existing approved client.
   Device approval is an explicit one-shot action performed locally by
   the authorized operator; it is never automatic.
6. Complete the redirect and independently verify authenticated
   \`device(status)\` for VAULTER and Surface. Record whether Leno and RTX
   reconnect, without inferring their status from Tailscale alone.
7. Independently assert that out-of-scope operations still return
   \`permission_denied\`, that tokens have the exact resource audience
   and permitted scope, and that existing clients and refresh grants
   survive the update. Do not log real tokens or callback code/state.
8. Confirm rollback *procedure* can restore the prior binary/config
   without replacing signing keys, registrations or database, with a
   measured restart/reconnect window and repeat preflight.

### Rollback trigger

Any new issuer mismatch, denied known-good client, unexpected expanded
scope, invalid JWKS, failed health/readiness, device regression or broken
refresh behavior is a **NO-GO**. Stop the rollout, preserve safe error
evidence, restore the known-good binary/config using the approved
procedure, and re-run status and denial checks. Never delete a user's
unrelated process or worktree.

## What this cannot guarantee

A read-only metadata preflight cannot observe ChatGPT's privately cached
issuer, client-side normalization, browser callback or persisted OAuth
state. No test suite can guarantee a service will never fail again. A
fresh real-client acceptance is mandatory before calling the production
issuer mismatch resolved.

After a separately authorized production release and acceptance, this
same preflight may be scheduled as a read-only metadata check to detect
future routing/configuration drift. Do not turn on recurring monitoring
against a known failing baseline and interpret it as new incident activity.
