# Remote Plane Security and Privacy

This document describes the implemented Plan D remote-plane trust boundaries.

## Trust boundary

The relay is a transport and identity-routing component. It is not the final authority for device actions.

Every remote canonical invocation still executes through the local tetherd AgentRuntime and local Policy Broker. A relay decision can prevent routing. It cannot convert a local DENY or REQUIRE_APPROVAL outcome into ALLOW.

The launch-bound local principal is authoritative on the device. An authenticated relay client identity is request provenance, not permission to replace that local principal.

## Identities

The remote plane distinguishes:

- owner identity vs explicitly configured operator identities at the relay;
- MCP client identity at the relay;
- local device identity;
- launch-bound local execution principal;
- transient MCP session identity.

Owner authorization uses positive allowlist verification across both the relay (`isAuthorizedOwnerIdentity`) and local `tetherd` (`SynchronizedDevicePolicy::resolve_principal`): only `human:<accountId>` (not marked `role: "operator"` and not using a reserved non-owner prefix) or an identity explicitly configured with `role: "owner"` in auth config (`StaticClientAuthenticator`, OIDC `bindings`, or OIDC `subject` strategy) holds owner authority. Reserved non-owner prefixes (`operator:`, `external:`, `guest:`, `unpaired:`, `service:`, `client:`) and unconfigured delegate/custom identities cannot acquire `owner` role or inherit `owner_policy`.

A remote MCP session is bound to the identity that initialized it. A different authenticated identity cannot reuse that session ID.

Device authentication uses a locally held high-entropy credential. The relay persists only its SHA-256 hash.

The built-in static client authenticator stores a hash of configured bearer tokens in memory. Its configuration file contains environment-variable names rather than raw bearer tokens.

## Pairing

Pairing requires both sides:

1. a device-generated credential hash starts a pending pairing;
2. a short one-time human code is returned;
3. an authenticated **owner** identity (`POST /pair/approve`, `GET /devices`, `POST /devices/:id/revoke` require owner authorization; operator/service tokens receive HTTP `403`) approves that code and binds `owner_principal_id`;
4. the device/account binding becomes active.

Pairing codes are transient and single-use. Pending pairings proactively evict expired entries and enforce bounded queue capacity (`DEFAULT_MAX_PENDING_PAIRINGS = 128`, returning `429`), while `/pair/start`, `/pair/approve`, and `/portal/api/session` enforce sliding-window rate limits with `Retry-After`.

A device already actively paired cannot silently replace its binding. It must first be revoked.

## Revocation

Revocation is scoped to the owning account and restricted to authorized owner credentials.

A successful revocation:

- records the revocation timestamp;
- causes future device authentication to fail;
- disconnects the current live device WebSocket;
- causes reconnect authentication with the revoked credential to fail;
- rejects Control Portal rollback or policy mutations targeting the revoked device.

A different account cannot revoke or route to the device.

## Synchronized policy defaults and durability

- **Owner default universal permissions**: Newly owner-paired devices initialize at revision `1` with universal access across all six Compact MCP families (`device`, `files`, `process`, `browser`, `desktop`, `batch`) and `allow_destructive: true`. Under this owner-approved default, allowed destructive actions (such as `filesystem.move` with `replace: true` and AI-owned `process.terminate`) do not prompt interactively, while human-coexistence boundaries remain strictly enforced: human-origin `process.terminate` is hard-denied and unshared human browser tabs/desktop windows remain inaccessible.
- **Explicit denies and operator isolation**: Explicit operation/family denies always take precedence over universal grants. Operator identities (`POST /portal/api/operators`) cannot collide with `human:<accountId>` or `owner_principal_id`, and all capability rules are validated against the canonical 49-operation catalog.
- **Lockdown recovery semantics**: Clicking **Lift Emergency Lockdown** in the Control Portal lifts emergency lockdown and restores baseline **Universal Access** (`profileId: "universal"`). Use **Recoverable Snapshots & Rollback** when restoring prior custom restrictions.
- **Fail-closed local durability**: `tetherd --relay-url` requires `--state-dir` so synchronized policies persist atomically via fsync+rename (`<state_dir>/policy/synchronized-policy.json`). Corrupt, unreadable, invariant-violating, or wrong-device persisted policy state fails closed at startup rather than silently resetting revision to `0`.

## Routing isolation

The router resolves a device inside the authenticated account boundary before sending a request.

Fail-closed cases include:

- unknown device;
- device owned by another account;
- revoked device;
- offline device;
- multiple online devices when the request omitted device_id.

Concurrent requests use independent transient route IDs.

A result is accepted only from the same live device connection generation that received the request and only when its canonical request_id matches.

## Disconnect and replay

The relay does not automatically replay an in-flight invocation after a WebSocket disconnect.

Pending calls fail as disconnected.

A reconnect creates a new connection generation. Requests from the old generation cannot complete pending calls on the new connection.

Mutation retry safety belongs to the canonical local idempotency mechanism. A caller that deliberately retries with the same valid idempotency key receives the locally stored result rather than an automatic second mutation. Reuse of a key for a conflicting mutation remains a local error.

## Transport security

Direct production relay binding uses HTTPS/WSS.

Plain HTTP/WS is allowed only when all of the following are true:

- the operator explicitly enables insecure localhost mode;
- the relay binds to localhost or a loopback address;
- the device also explicitly allows insecure loopback WebSocket transport.

This mode is intended for tests, local development, or a trusted same-host TLS reverse proxy. When terminating TLS at an upstream trusted reverse proxy, configure `--public-origin https://...` (and optionally `--trust-proxy-headers` to require single-valued `X-Forwarded-Proto`/`X-Forwarded-Host` matching `--public-origin`) so portal session cookies enforce the `Secure` attribute and same-origin validation checks the external HTTPS origin. Arbitrary `X-Forwarded-*` headers are ignored when `--trust-proxy-headers` is not enabled, and cookie-authenticated mutations missing both `Origin` and `Referer` are denied.

tetherd requires wss:// by default.

## Hosted relay visibility

A hosted relay that terminates the MCP HTTP connection can see the MCP requests and results that transit it.

Tetherplane therefore does not claim generic end-to-end secrecy between MCP client and device when using such a relay.

Current relay behavior is designed to keep tool payloads transient:

- the device router keeps pending requests in memory;
- MCP session state is in memory;
- no tool argument/result persistence is implemented by the relay;
- no file content or process output persistence is implemented by the relay.

The durable relay registry stores only bounded pairing metadata:

- device ID;
- account ID;
- device credential hash;
- pairing timestamp;
- revocation timestamp.

Self-hosting places this relay visibility under the operator's infrastructure control.

## Local mode

Local mode does not involve the relay.

The local stdio Compact MCP path continues to function independently and requires no hosted service.

## Secrets and logging

The relay must not log:

- raw device credentials;
- bearer tokens;
- browser cookies;
- authorization headers;
- MCP tool payloads merely for debugging.

The current CLI prints listening endpoint addresses only.

Device credentials are supplied to tetherd through a credential file rather than a command-line secret value.

Static client bearer values are resolved from environment variables at runtime rather than being stored in the auth metadata JSON.

## Reverse proxy and OAuth/OIDC

The relay exposes a ClientAuthenticator boundary so external identity integration does not enter canonical capability semantics.

A reverse-proxy deployment must preserve the distinction between authenticated identity and local execution authority.

Do not trust user-supplied identity headers or arbitrary forwarded headers directly from the public network (`--trust-proxy-headers` only validates single-valued `X-Forwarded-Proto`/`X-Forwarded-Host` against an explicitly configured `--public-origin`). If a proxy converts OAuth/OIDC identity into an internal authentication form, the relay-facing hop must be protected and the relay should remain loopback/private-network bound as appropriate.

The built-in static authenticator is a controlled self-host/development option, not an OAuth authorization server.

## Out of scope

The primary security boundary does not attempt to defeat malware already running with the same or greater operating-system privileges as tetherd.

The remote plane also does not make arbitrary third-party application mutations reversible. Checkpoints and idempotency support recovery and conflict detection, not universal rollback.

## OIDC resource-server authentication

The optional OIDC authenticator verifies RS256 access tokens against a configured HTTPS issuer, audience and JWKS endpoint, requires expiry and scopes, and maps only explicitly configured subject/client pairs (or subject-prefix identities with explicit owner/operator role assignment) to relay identities. It never accepts caller-supplied account or principal claims as authority. See [OAuth deployment details](../remote/chatgpt-oauth.md).
