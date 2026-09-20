# Remote Plane Security and Privacy

This document describes the implemented Plan D remote-plane trust boundaries.

## Trust boundary

The relay is a transport and identity-routing component. It is not the final authority for device actions.

Every remote canonical invocation still executes through the local tetherd AgentRuntime and local Policy Broker. A relay decision can prevent routing. It cannot convert a local DENY or REQUIRE_APPROVAL outcome into ALLOW.

The launch-bound local principal is authoritative on the device. An authenticated relay client identity is request provenance, not permission to replace that local principal.

## Identities

The remote plane distinguishes:

- human/account identity at the relay;
- MCP client identity at the relay;
- local device identity;
- launch-bound local execution principal;
- transient MCP session identity.

A remote MCP session is bound to the identity that initialized it. A different authenticated identity cannot reuse that session ID.

Device authentication uses a locally held high-entropy credential. The relay persists only its SHA-256 hash.

The built-in static client authenticator stores a hash of configured bearer tokens in memory. Its configuration file contains environment-variable names rather than raw bearer tokens.

## Pairing

Pairing requires both sides:

1. a device-generated credential hash starts a pending pairing;
2. a short one-time human code is returned;
3. an authenticated account approves that code;
4. the device/account binding becomes active.

Pairing codes are transient and single-use.

A device already actively paired cannot silently replace its binding. It must first be revoked.

## Revocation

Revocation is scoped to the owning account.

A successful revocation:

- records the revocation timestamp;
- causes future device authentication to fail;
- disconnects the current live device WebSocket;
- causes reconnect authentication with the revoked credential to fail.

A different account cannot revoke or route to the device.

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

This mode is intended for tests, local development, or a trusted same-host TLS reverse proxy.

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

Do not trust user-supplied identity headers directly from the public network. If a proxy converts OAuth/OIDC identity into an internal authentication form, the relay-facing hop must be protected and the relay should remain loopback/private-network bound as appropriate.

The built-in static authenticator is a controlled self-host/development option, not an OAuth authorization server.

## Out of scope

The primary security boundary does not attempt to defeat malware already running with the same or greater operating-system privileges as tetherd.

The remote plane also does not make arbitrary third-party application mutations reversible. Checkpoints and idempotency support recovery and conflict detection, not universal rollback.
