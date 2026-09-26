# ChatGPT OAuth edge

The relay is an OAuth protected resource, not an authorization server. Use a conforming authorization server for login, consent, authorization-code exchange and PKCE S256. This can be an external provider or Tetherplane's reference self-hosted `tether-auth` service. The six Compact MCP tools and the device's launch-bound local authority are unchanged.

## Configuration

Pass this metadata file using the existing `--auth-config` option. Replace example identifiers with values from the provider and the existing relay device account. No bearer token, client secret or signing private key belongs in this file.

```json
{
  "oidc": {
    "issuer": "https://YOUR-TENANT.auth0.com/",
    "audience": "https://relay.example.com/mcp",
    "jwksUri": "https://YOUR-TENANT.auth0.com/.well-known/jwks.json",
    "scopes": ["tetherplane:access"],
    "bindings": [{
      "subject": "PROVIDER-USER-SUBJECT",
      "clientId": "REGISTERED-OAUTH-CLIENT-ID",
      "accountId": "EXISTING-RELAY-ACCOUNT-ID",
      "principalId": "human:owner"
    }]
  }
}
```

The audience is the canonical HTTPS MCP resource URL, including `/mcp`. Configure the provider's API/resource identifier to match exactly. The issuer must match its discovery document exactly, including any trailing slash. Use its trusted JWKS URL; token headers never choose the key endpoint. This initial integration accepts RS256 JWT access tokens only. It requires expiry, issuer, audience, subject, all configured scopes, and an explicitly bound subject/client pair. The client claim is `azp` or `client_id`; conflicting values are rejected. Unknown identities fail closed. JWT account/principal claims cannot override the configured binding.

Static `clients` configuration with `token_env` remains supported for development. OIDC and static credentials cannot be mixed in one configuration. Configuration changes require relay restart. JWKS retrieval uses jose caching, rotation handling and a five-second timeout. Provider/key failures fail closed without logging tokens.

## Self-hosted Tetherplane provider

The production-operable self-hosted reference is documented in [Self-hosting the Tetherplane Authorization Server](self-host-auth.md). It uses the pinned `oidc-provider` implementation, PKCE S256, RFC 8707 resource indicators, DCR, persistent SQLite authorization state, explicit JWKS signing keys, device-assisted account proof, and refresh/revocation persistence.

The relay remains provider-neutral. When using `tether-auth`, configure the relay with the same stable issuer, canonical MCP audience/resource, trusted JWKS endpoint, required `tetherplane:access` scope, and verified subject identity strategy. External conforming providers remain supported.

## Provider and ChatGPT setup

1. Use a stable public HTTPS hostname for the relay. A changing tunnel hostname requires updating the resource/audience and reconnecting the client.
2. Configure an API/resource with the exact audience and `tetherplane:access` scope. Enable RS256 access tokens and authorization-code + PKCE S256. Configure the provider to honor the OAuth `resource` parameter.
3. Verify the provider's `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration` advertises its authorization/token endpoints and `code_challenge_methods_supported` including `S256`.
4. Configure a predefined OAuth client for the first proof, using the callback URI supplied by the current ChatGPT setup UI. Alternatively configure supported CIMD/DCR and then bind the resulting exact client ID. Do not allow arbitrary dynamically registered clients by wildcard. Ensure requested OIDC scopes are enabled if advertised.
5. Add the intended user's subject and client ID to `bindings`. Use the account ID already owning Leno; inventing a different account makes the paired device inaccessible. Remote principal identity remains provenance and cannot expand the device's local profile.
6. Start the relay with this auth configuration and existing TLS or trusted same-host reverse-proxy settings. Expose the resource metadata routes as well as `/mcp`. Keep the local listener loopback-only when TLS is terminated by a proxy.
7. Connect ChatGPT to the public `/mcp` URL, complete provider login, list the six tools, then call `device` with `op=status` and `device=Leno`. Exercise an outside-root denial to verify local enforcement.

The relay serves both `/.well-known/oauth-protected-resource` and the resource-path-specific metadata URL (normally `/.well-known/oauth-protected-resource/mcp`). Metadata URLs come from configuration, never forwarded Host headers. In OAuth mode, initialization without valid credentials creates an anonymous discovery session, including when the client sends an invalid, expired or insufficient-scope bearer. It permits only the initialized notification, ping and tool listing; all six descriptors include top-level and `_meta` OAuth security schemes. Unauthenticated tool calls return an error result with `mcp/www_authenticate` and perform no execution or routing, including local schema lookup.

A valid scoped OAuth bearer binds the anonymous session to its authenticated account, client and principal. Subsequent requests must authenticate as that exact identity; a session ID alone grants no authority. Invalid credentials cannot downgrade or borrow a bound session: discovery returns HTTP 401, while tool calls receive the authentication error result. Anonymous GET and DELETE requests are rejected. Static bearer mode continues to require authentication before initialization and session creation. For Codex CIMD, bind the external client identifier in `azp` (`https://chatgpt.com/oauth/codex/client.json`), not the provider's internal application ID.

## Verification and limits

Automated tests generate ephemeral signing keys and cover rejected signature, issuer, audience, expiry/not-before, missing scope and unbound identities; discovery, tool metadata, reauthentication and static-mode compatibility are exercised over HTTP. Remote-plane E2E tests run with both static credentials and signed OIDC access tokens against real tetherd, proving the outbound device path, local policy denial, account isolation, reconnect, idempotency and revocation.

These tests do not establish that a real public endpoint or ChatGPT account linking is configured. Record a separate live proof after deployment. For the self-hosted reference provider, A3 tests additionally prove DCR client persistence, grant/refresh persistence across restart, and persisted grant-wide revocation. Existing device revocation remains available.

References: [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [MCP authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization).
