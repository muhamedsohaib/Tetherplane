# Self-hosting the Tetherplane Authorization Server

`tether-auth` is Tetherplane's reference self-hosted OAuth/OIDC authorization server for external MCP clients such as ChatGPT and Codex. It uses the pinned `oidc-provider` implementation for protocol handling and a file-backed SQLite adapter for durable authorization state.

OAuth remains an edge identity protocol. The relay verifies the resulting identity, while the local Tetherplane agent and its Policy Broker remain the final authority for every machine capability. Deploying `tether-auth` does not expand filesystem, process, browser, desktop, or foreground authority on a device.

Reference path:

    ChatGPT / Codex / MCP client
             |
             | OAuth 2.1 authorization code + PKCE S256
             v
         tether-auth
             |
             | resource-bound signed access token
             v
         tether-relay
             |
             | authenticated remote provenance
             v
          tetherd
             |
             v
    local Policy Broker -> providers

## Build

From the repository root:

    pnpm install
    pnpm --filter @tetherplane/auth build

The executable is `auth/dist/cli.js`; the package also exposes the `tether-auth` binary entry point.

The production deployment requires:

- a stable HTTPS issuer;
- the relay's canonical HTTPS `/mcp` resource URL;
- a persistent SQLite file path;
- an explicit JWKS file containing the authorization server signing key material;
- a relay device-login bridge origin;
- a bridge credential referenced by environment-variable name;
- direct TLS or explicit loopback-only plaintext behind a trusted same-host TLS reverse proxy.

There is no production in-memory adapter fallback and no generated signing key fallback.

A deployment metadata file has this shape:

```json
{
  "issuer": "https://auth.example.com/",
  "resource": "https://relay.example.com/mcp",
  "databasePath": "/var/lib/tetherplane-auth/provider.sqlite",
  "jwksFile": "/run/secrets/tether-auth-jwks.json",
  "relay": {
    "url": "https://relay.example.com",
    "bridgeTokenEnv": "TETHERPLANE_AUTH_BRIDGE_TOKEN"
  }
}
```

The bridge token value is not stored in this JSON file. Supply it through the named environment variable from the host's secret-management mechanism.

## Production container

The repository includes `Dockerfile.auth`. It uses Node 22, runs as the non-root `tetherplane` account, exposes port 8790, and keeps authorization-server state under the persistent `/var/lib/tetherplane-auth` volume. No JWKS, bridge token, TLS private key, OAuth token, client secret, or user credential is baked into the image.

Build:

    docker build -f Dockerfile.auth -t tetherplane-auth:local .

Example with direct TLS termination:

    docker run --rm \
      --name tetherplane-auth \
      -p 8790:8790 \
      --env-file /secure/tether-auth.env \
      -v tetherplane-auth-state:/var/lib/tetherplane-auth \
      -v /secure/tether-auth.json:/run/config/tether-auth.json:ro \
      -v /secure/tether-auth-jwks.json:/run/secrets/tether-auth-jwks.json:ro \
      -v /secure/auth-cert.pem:/run/secrets/auth-cert.pem:ro \
      -v /secure/auth-key.pem:/run/secrets/auth-key.pem:ro \
      tetherplane-auth:local \
      --config /run/config/tether-auth.json \
      --host 0.0.0.0 \
      --port 8790 \
      --tls-cert /run/secrets/auth-cert.pem \
      --tls-key /run/secrets/auth-key.pem

The env file should contain the bridge credential named by `bridgeTokenEnv`, for example `TETHERPLANE_AUTH_BRIDGE_TOKEN`. Protect the env file as a secret and do not commit it.

When a trusted reverse proxy terminates TLS on the same host, bind `tether-auth` only to loopback and opt in explicitly:

    node auth/dist/cli.js \
      --config /secure/tether-auth.json \
      --host 127.0.0.1 \
      --port 8790 \
      --allow-insecure-localhost

Do not expose that plaintext loopback listener directly to the network.

## Sensitive files and volumes

Treat the following as sensitive operational state:

- the JWKS file, because it contains private signing key material;
- the SQLite database, because it contains OAuth sessions, dynamic clients, grants, refresh-token state, authorization codes, and related provider records;
- the relay bridge credential;
- TLS private keys;
- any environment file or secret-manager record containing those values.

The deployment metadata file contains references and public endpoint metadata, not the bridge token or signing key itself. It should still be writable only by the operator because changing its paths or issuer/resource values changes the security boundary.

Use restrictive host permissions. Mount JWKS and TLS key files read-only. Do not put secret values into command-line arguments, container images, Git history, test fixtures, request logs, or crash reports.

## Backup and restore

The reference adapter uses SQLite WAL mode. **Do not simply copy the SQLite database file while `tether-auth` is running.** A live WAL may contain committed state that is not present in the main database file yet.

For the simple reference deployment:

1. stop `tether-auth` cleanly;
2. verify the process has exited;
3. back up `provider.sqlite`;
4. back up the JWKS separately using the secret-management procedure for signing keys;
5. record the stable issuer and resource URLs used by that deployment;
6. restart the service.

For an online backup, use a SQLite-aware online backup mechanism or an atomic storage snapshot that captures the database, WAL, and SHM state together. Tetherplane does not currently ship an online-backup command.

To restore:

1. stop the service;
2. restore the database into the configured persistent path;
3. restore a JWKS containing every signing key still needed to validate unexpired JWTs;
4. restore restrictive file ownership/permissions;
5. start the service with the same intended issuer/resource;
6. check `/readyz`, discovery metadata, JWKS publication, and a controlled OAuth acceptance flow before reopening public traffic.

Restoring an old database can restore old dynamic client/grant state. Treat restore as a security-sensitive operator action and reconcile any revocations made after the backup.

## Signing-key rotation

Signing keys are supplied explicitly through the mounted JWKS file; Tetherplane does not generate production signing keys into source or state.

Use a staged rotation:

1. generate the replacement asymmetric signing key outside the repository with approved operator tooling;
2. give the new key a unique `kid`;
3. update the protected JWKS so the old and new verification keys are both available during the overlap period;
4. restart `tether-auth`;
5. verify the public JWKS endpoint exposes the intended overlap set and perform a controlled token issuance to confirm the intended new signing key is being used;
6. retain the old verification key for at least the maximum lifetime of every JWT that may still have been signed by it, plus operational clock-skew margin;
7. remove the retired key, restart again, and verify issuance and relay validation.

Do not remove an old key merely because refresh tokens have rotated. Refresh tokens can outlive an access token and later mint a new access token using the then-current signing key. The important retirement condition is that no unexpired JWT signed by the old key still needs validation.

If key compromise is suspected, prioritize revocation and incident response over a normal overlap rotation.

## Health and observability

Unauthenticated operational probes deliberately contain no account, client, token, device, or session data:

- `GET /healthz` -> `{"status":"ok"}`
- `GET /readyz` -> `{"status":"ready"}`

The CLI logs the listening address, configured issuer, and configured resource. Those are public deployment metadata.

Safe operational telemetry can include:

- process uptime/restarts;
- health/readiness state;
- route class and HTTP status counts;
- bounded latency histograms;
- SQLite/storage error counts;
- aggregate login/consent/registration success/failure counts without identifiers.

Do not log Authorization headers, cookies, authorization codes, refresh/access tokens, client secrets, bridge credentials, device-login user codes, JWKS private fields, full request bodies, or SQLite row payloads. Configure reverse proxies and APM products with the same redaction rules.

Dynamic registration is an internet-facing write path. Apply reasonable connection/request-rate limits at the public edge without changing OAuth semantics.

## Stable domain and TLS

The issuer is an OAuth identity boundary, not a disposable hostname. Use a stable public HTTPS hostname and keep the issuer URL consistent with discovery metadata.

The relay resource identifier is also stable and must remain the exact canonical HTTPS MCP URL, including `/mcp`.

A temporary tunnel URL is suitable for a development proof only. Do not use a temporary tunnel as the production issuer or OAuth resource identifier. Changing either hostname later invalidates assumptions encoded in client registration, audience checks, discovery metadata, and existing tokens.

For direct serving, provide `--tls-cert` and `--tls-key`. If TLS is terminated by a trusted same-host reverse proxy, keep the auth listener on loopback and use `--allow-insecure-localhost`. Never use that flag for a non-loopback bind.

## Relay configuration

The relay remains provider-neutral. Point its OIDC verifier at the self-hosted issuer exactly as you would point it at another conforming provider.

For the public subject-mapping mode:

```json
{
  "oidc": {
    "issuer": "https://auth.example.com/",
    "audience": "https://relay.example.com/mcp",
    "jwksUri": "https://auth.example.com/jwks",
    "scopes": ["tetherplane:access"],
    "identity": {
      "strategy": "subject",
      "principalPrefix": "human:"
    }
  },
  "deviceLoginBridge": {
    "tokenEnv": "TETHERPLANE_AUTH_BRIDGE_TOKEN"
  }
}
```

The bridge token environment value on the relay must match the credential referenced by the auth deployment. The browser/OAuth client never receives this bridge credential.

The relay still verifies signature, issuer, audience, token time bounds, required scope, subject, and client identity on every authenticated request. The local device then replaces remote principal claims with its launch-bound local principal before policy evaluation.

## ChatGPT and MCP acceptance proof

Automated A3 acceptance tests use ephemeral signing material and a temporary SQLite database. They prove that:

- discovery advertises PKCE S256 and dynamic registration;
- an OAuth public client using `token_endpoint_auth_method=none` can register through DCR;
- that dynamic client survives an auth-service restart;
- grants and refresh-token state survive restart;
- grant-wide revocation removes the persisted grant and refresh-token state;
- relay tests continue rejecting invalid signature, issuer, audience, expiry/not-before, scope, subject, and client claims;
- the six default MCP tools remain unchanged.

For Codex CIMD, the relay's verified subject strategy continues to accept the externally verified client identifier in `azp` or `client_id`; it does not trust a client identity supplied in an MCP body.

These deterministic tests are not a claim that a particular public DNS record, TLS certificate, ChatGPT account, or plugin installation is live. Record a separate live proof after deployment:

1. verify the public discovery and JWKS endpoints over the final HTTPS hostname;
2. verify the relay's protected-resource metadata points to the same issuer and canonical MCP resource;
3. connect the client and complete device-assisted login and consent;
4. confirm the client sees exactly `device`, `files`, `process`, `browser`, `desktop`, and `batch`;
5. call a harmless status/read operation;
6. exercise an intentionally out-of-scope local operation and confirm the local Policy Broker denies it.

A successful OAuth login proves identity at the edge. It does not grant broader local computer authority.
