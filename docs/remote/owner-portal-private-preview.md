# Private synthetic owner portal preview

Use this workflow to review the existing dashboard on authorized desktop and
mobile browsers. It runs a separate synthetic relay and never loads production
OAuth settings, paired devices, agent tasks, or state.

## Start and expose only the portal

Build the relay first:

```powershell
pnpm --filter @tetherplane/relay build
```

The server always binds to loopback. For a private HTTPS reverse proxy, provide
its exact origin (replace the example hostname with the preview machine's
existing Tailscale DNS name):

```powershell
node scripts/owner-portal-preview.mjs --port 4788 --public-origin https://preview-machine.example-tailnet.ts.net:9448
```

The origin must be HTTPS without credentials, a path, query, or fragment.
Forwarded headers remain untrusted. The configured origin pins browser-origin
checks and enables Secure cookies; it does not enable public hosting.

Inspect existing Tailscale Serve configuration before adding a dedicated route.
For an authorized, unused port, expose only the portal path:

```powershell
tailscale serve status --json
tailscale serve --bg --https=9448 --set-path=/portal http://127.0.0.1:4788/portal
```

Use Tailscale Serve within the private tailnet, never public Funnel for this
preview. Preserve other routes. To remove only this preview mapping:

```powershell
tailscale serve --https=9448 --set-path=/portal off
```

## Preview credential handling

Each fresh process generates a random preview-only owner token unless a custom
token was explicitly supplied. The token has process lifetime; restarting with
a fresh default token invalidates the previous one. It authorizes only this
isolated synthetic relay.

Startup output contains the credential, including when using --json-ready.
When an automated launcher starts the preview, capture that output privately;
do not return it through tools or save it as a general log. A dedicated runtime
credential file must be outside Git, production state, and all served paths.
Restrict its directory to the current Windows user before writing the token.
Remove credential files when the preview stops.

Open the credential file locally and enter its token once per browser. Do not
put the token in chat, URLs, screenshots, source, or reports. The portal exchanges
it for an HttpOnly, SameSite=Strict session cookie, marked Secure with the HTTPS
origin. Sessions last at most eight hours and end on logout or server shutdown.
The token itself has no separate timed expiration.

This preview does not replace production sign-in. The existing production
TetherAuth/OIDC path and its private read-only release constraints are separate.

## Verify before sharing

Run the focused CLI and portal checks:

```powershell
node --test tests/e2e/owner-portal-preview.test.ts
node --test relay/test/portal-security.test.ts relay/test/portal-owner-navigation.test.ts
```

Then verify the actual HTTPS route: page loads; unauthenticated and invalid-token
access is denied; preview login creates a secure cookie; only the four Synth-*
devices appear; cross-origin and missing-CSRF operations are denied; logout
revokes access. The path-specific proxy must not expose /pair/start or /mcp.

A private preview and desktop/mobile browser tests do not establish physical
phone acceptance or production fleet reliability.
