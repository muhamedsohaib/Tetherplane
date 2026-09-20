# Tetherplane Remote Plane Implementation Plan

**Goal:** Deliver the canonical Plan D remote plane: paired device identity, outbound authenticated WSS from `tetherd`, authenticated Streamable HTTP MCP at the relay, account/device routing, revocation, reconnect-safe execution, and a self-hostable relay.

**Source requirements:** `2026-09-17-tetherplane-design.md`, `2026-09-17-tetherplane-implementation-roadmap.md`, and the model-neutral control-plane addendum.

## Hard boundaries

- The relay routes and authenticates; it never overrides a local Policy Broker denial.
- Device connectivity is outbound-only. No inbound listener is opened on the controlled device.
- Remote callers are authenticated as account/client identities, but local authority is still the launch-bound principal enforced by `tetherd`.
- Relay payloads are transient by default. Tool arguments/results are not durably stored.
- Device credentials are generated locally, stored only as hashes at the relay, revocable, and never logged.
- Reconnect logic never blindly replays mutation requests.
- Existing local stdio mode remains available with no relay dependency.
- Compact MCP still exposes exactly six tools.
- Hosted/self-hosted privacy behavior is documented accurately.

## D1 — Relay identity, pairing, and durable device registry

Create the TypeScript `relay/` package with separated `auth`, `devices`, `routing`, and `mcp` modules.

Implement a pluggable client authenticator. Tests use static bearer identities; production/self-host deployments can place OAuth/OIDC in front of the same identity interface.
Pairing flow:

1. the device generates a high-entropy local credential;
2. `POST /pair/start` submits device ID plus the credential hash and receives a short human code;
3. an authenticated account approves the human code;
4. the approved binding is persisted as account + device + credential hash;
5. the device authenticates future WebSocket connections using its local credential;
6. revocation invalidates the binding and terminates any live connection.

Persist only bounded identity metadata and credential hashes. Do not persist MCP payloads.

## D2 — Device directory and routed RPC

Implement one live outbound WebSocket session per paired device.

Relay-to-device messages contain a route ID and canonical invocation envelope. Device-to-relay messages return the same route ID plus a canonical result envelope.

The router must:

- resolve a requested device only within the authenticated account;
- fail closed on cross-account or unknown-device routes;
- bind remote actor/client provenance at the relay;
- correlate concurrent calls;
- bound request timeouts;
- fail pending calls on disconnect;
- never auto-resend a request after disconnect.

## D3 — `tetherd` outbound relay transport

Add a second `tetherd` transport mode alongside `--stdio-rpc`.

Remote mode accepts:

- `--relay-url`;
- `--device-id`;
- `--device-credential-file`;
- the existing `--allow`, principal profile, state directory, and browser bridge options.
`tetherd` connects outward using authenticated WebSocket transport, receives canonical invocations, executes them through the same `AgentRuntime`, and sends canonical results.

Production relay URLs must use `wss://`. A test-only/explicit localhost option may allow `ws://` for deterministic local integration tests.

The remote transport must not add a second policy path.

## D4 — Streamable HTTP Compact MCP relay edge

Expose current MCP Streamable HTTP at `/mcp`.

Authenticate the MCP client before creating/binding its MCP session. Each remote Compact MCP call uses the existing six-tool translation and a relay `AgentCaller` that routes to the paired device.

The relay injects authenticated client provenance and never trusts a caller-supplied account/principal claim.

## D5 — Revocation, reconnect, and idempotency

Prove:

- revoked device credentials cannot reconnect;
- revocation closes an existing live device session;
- a dropped WebSocket fails the pending relay request rather than replaying it;
- a caller retry with the same canonical idempotency key relies on the local durable idempotency store and does not re-execute the mutation;
- conflicting idempotency reuse still fails locally;
- reconnect does not alter device/account binding.

## D6 — Black-box NAT-style remote proof
Start a real relay listener and a real `tetherd` process on the same test host, but give `tetherd` **no inbound listener**.

Drive the system as:

`MCP Streamable HTTP client -> relay -> outbound device WebSocket -> tetherd -> local policy/kernel/providers`.

Prove:

1. pairing and approval bind the device to account A;
2. account A can remotely read/write inside the granted sandbox;
3. an outside-root request is denied locally and the relay cannot change the denial;
4. account B cannot route to account A's device;
5. an unknown second device ID fails closed;
6. the device can disconnect and reconnect;
7. a mutation retry with one idempotency key executes once;
8. local stdio MCP still works while relay support exists.

## D7 — Self-host deployment and privacy documentation

Provide:

- relay CLI;
- TLS certificate/key configuration;
- static development auth fixture support without embedding secrets;
- self-host configuration example;
- pairing/revocation instructions;
- privacy/retention documentation;
- reverse-proxy/OIDC integration notes.

Do not claim end-to-end secrecy when the relay terminates the MCP connection.

## D8 — Final Plan D gate

Run the complete Rust/TypeScript/E2E repository gate plus remote-plane tests.

Plan D is complete only when the outbound-only black-box proof, isolation tests, revocation tests, reconnect/idempotency tests, and existing local/browser/RDC suites are all green in the same verified tree.
