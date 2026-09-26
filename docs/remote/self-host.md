# Self-hosting the Tetherplane Relay

The Tetherplane remote plane lets an MCP client reach a paired machine without opening an inbound control port on that machine.

Network path:

    MCP client
        |
        | Streamable HTTP
        v
    tether-relay
        |
        | outbound device WebSocket
        v
    tetherd
        |
        v
    local principal -> local Policy Broker -> providers

The relay routes requests. It does not become the final authority for device actions.

## Build

From the repository root:

    pnpm.cmd install
    pnpm.cmd --filter @tetherplane/relay build
    pnpm.cmd --filter @tetherplane/auth build
    cargo build -p tetherd --release

The relay executable is relay/dist/cli.js. The package also exposes the tether-relay binary entry point. The optional self-hosted authorization server is auth/dist/cli.js and exposes the tether-auth binary entry point.


## Production relay container

The repository includes `Dockerfile.relay` for a reproducible Node 22 relay image. The runtime uses a non-root `tetherplane` account and does not bake auth configuration, bearer tokens, device credentials, TLS private keys, or certificates into the image.

Build from the repository root:

    docker build -f Dockerfile.relay -t tetherplane-relay:local .

For direct TLS termination, mount authentication metadata and TLS material at runtime and keep relay state on a persistent volume:

    docker run --rm \
      --name tetherplane-relay \
      -p 8788:8788 \
      -v tetherplane-relay-state:/var/lib/tetherplane \
      -v /secure/tether-relay-auth.json:/run/secrets/tether-relay-auth.json:ro \
      -v /secure/relay-cert.pem:/run/secrets/relay-cert.pem:ro \
      -v /secure/relay-key.pem:/run/secrets/relay-key.pem:ro \
      tetherplane-relay:local \
      --auth-config /run/secrets/tether-relay-auth.json \
      --state-file /var/lib/tetherplane/devices.json \
      --host 0.0.0.0 \
      --port 8788 \
      --tls-cert /run/secrets/relay-cert.pem \
      --tls-key /run/secrets/relay-key.pem

For OAuth/OIDC, the mounted auth config contains provider metadata and explicit identity bindings only. Provider secrets remain in the identity provider or its secret-management mechanism.

The relay exposes unauthenticated operational probes containing no device, account, session, or credential data:

- `GET /healthz` -> `{"status":"ok"}`
- `GET /readyz` -> `{"status":"ready"}`

These endpoints are intended for container/orchestrator liveness and readiness checks. They do not grant MCP or device authority.

A public ChatGPT/plugin deployment must use a stable public HTTPS hostname. Temporary tunnel URLs are appropriate for development only and must not be treated as production identity or OAuth resource identifiers.


## Client authentication config

The development/self-host static authenticator deliberately does not accept raw bearer tokens in its JSON config.

Example auth metadata:

    {
      "clients": [
        {
          "token_env": "TETHERPLANE_CLIENT_TOKEN",
          "account_id": "account-owner",
          "client_id": "mcp-client",
          "principal_id": "human:owner"
        }
      ]
    }

Set the referenced environment variable using the secret-management mechanism appropriate for the host. Do not put the token value into the JSON file, Git history, service unit, or command-line arguments.

For production OAuth/OIDC, use a conforming external provider or Tetherplane's reference self-hosted `tether-auth` service. Static bearer configuration is intended for controlled self-host deployments and development, not as a substitute for OAuth identity. The self-hosted authorization-server deployment, persistence, backup, and rotation procedures are documented in [Self-hosting the Tetherplane Authorization Server](self-host-auth.md).

## TLS

Direct non-loopback relay binding requires TLS.

Example shape:

    node relay/dist/cli.js ^
      --auth-config C:\secure\tether-relay-auth.json ^
      --state-file C:\ProgramData\Tetherplane\relay\devices.json ^
      --host 0.0.0.0 ^
      --port 8788 ^
      --tls-cert C:\secure\relay-cert.pem ^
      --tls-key C:\secure\relay-key.pem

This produces HTTPS for MCP/control endpoints and WSS for devices.

For local development, or when a trusted same-host reverse proxy terminates TLS:

    node relay/dist/cli.js ^
      --auth-config C:\secure\tether-relay-auth.json ^
      --state-file C:\ProgramData\Tetherplane\relay\devices.json ^
      --host 127.0.0.1 ^
      --port 8788 ^
      --allow-insecure-localhost

Plain HTTP/WS mode refuses non-loopback binding.

## Pair a device

Pairing is two-stage. The device contributes a locally generated secret only in hashed form to the relay. A human account then approves the short pairing code.

1. Generate a high-entropy device credential on the device and save it to a local credential file with restricted permissions.
2. Compute its SHA-256 hash locally.
3. Send deviceId and credentialHash to POST /pair/start.
4. The relay returns a short human code.
5. Approve that code with an authenticated account using POST /pair/approve.
6. Start tetherd with the original local credential file.

The relay persists only the credential hash and account/device binding. The raw device credential stays on the device.

Pair start request shape:

    {
      "deviceId": "Leno",
      "credentialHash": "<sha256-hex>"
    }

Approval request shape:

    {
      "userCode": "ABCD-1234"
    }

Authenticated management endpoints use the same bearer identity as MCP:

- GET /devices
- POST /devices/<device-id>/revoke

Revocation invalidates the stored device binding and disconnects the live device immediately.

## Start tetherd in remote mode

Remote mode is mutually exclusive with --stdio-rpc for the same process.

Example shape:

    target\release\tetherd.exe ^
      --relay-url wss://relay.example.com:8788/device ^
      --device-id Leno ^
      --device-credential-file C:\ProgramData\Tetherplane\device.credential ^
      --allow C:\Users\Sohaib\source ^
      --principal-profile C:\ProgramData\Tetherplane\principal.json ^
      --state-dir C:\ProgramData\Tetherplane\state

The device makes the outbound WebSocket connection. The relay does not connect inbound to tetherd.

For a local integration test only, tetherd accepts loopback ws:// when --relay-allow-insecure-localhost is also present.

## Local principal remains authoritative

Remote client identity and local execution authority are deliberately separate.

The relay authenticates the remote account/client and records that identity as request provenance. When the invocation reaches tetherd, AgentRuntime replaces the incoming principal with the launch-bound local principal before policy evaluation.

Consequences:

- a relay client cannot grant itself a broader local principal;
- relay account access does not expand filesystem roots;
- relay routing cannot override a local policy denial;
- a local principal can expose a narrower capability set than the remote account requests.

## Connect an MCP client

The MCP endpoint is https://<relay-host>:<port>/mcp.

It is MCP Streamable HTTP and exposes the same default six-tool Compact MCP surface:

- device
- files
- process
- browser
- desktop
- batch

The MCP request must carry the configured bearer identity. Session identity is bound when the MCP session is initialized. A different authenticated identity cannot reuse that MCP session ID.

## Reconnect and retries

Device WebSocket reconnect is transport recovery only.

The relay does not automatically replay a request that was in flight when the device disconnected. The pending call fails as disconnected.

A caller may retry a mutation with the same canonical idempotency key. The local device idempotency store decides whether the mutation is replayed from prior state or rejected as conflicting. This prevents relay reconnect from becoming a second execution authority.

## Reverse proxy and OIDC

A production deployment may terminate TLS and OAuth/OIDC at a same-host reverse proxy, then forward only to the relay loopback plaintext listener.

Requirements:

- the relay must bind only to loopback in this mode;
- the proxy must not expose the device WebSocket path without the required device credential headers;
- client authentication must remain bound to a reviewed ClientAuthenticator implementation or equivalent trusted adapter;
- do not trust arbitrary internet-supplied identity headers directly;
- preserve Authorization semantics or replace them only inside a reviewed trusted boundary.

The built-in static bearer authenticator is intentionally simple. It is not an OAuth authorization server.

## State and backup

The relay device registry persists:

- device ID;
- owning account ID;
- credential hash;
- paired timestamp;
- revocation timestamp.

It does not persist MCP tool arguments, tool results, file contents, process output, or raw bearer/device credentials.

Back up the registry state file if preserving device/account pairings matters. Backing it up does not recover the raw device credential; that credential must remain protected on the device.

## Local-only mode

Remote support does not replace local mode.

Local path:

    MCP client -> local Compact MCP stdio adapter -> tetherd --stdio-rpc

No relay is required for local operation.

## ChatGPT OAuth

The relay's OIDC resource-server integration and client-facing setup are documented in [ChatGPT OAuth edge](chatgpt-oauth.md). Tetherplane can use either an external conforming authorization server or the reference [self-hosted tether-auth service](self-host-auth.md). Static development authentication remains available.
