# Self-hosted tether-auth cutover — Vaulter

**Date:** 2026-10-09  
**Status:** Staged plan, not deployed or approved as verified.  
**Baseline:** `main` at `5feee084eb24bfd4831ab42840bb5f10dafc8113`.  
**Target:** Vaulter for the relay and authorization server; canonical source remains GitHub and Leno.  
**Objective:** Replace the external Auth0 authorization server with the repository's own `tether-auth`, while retaining the existing public MCP URL, six-tool catalog, device routing, and local Policy Broker. No purchase or external messaging is required.

## Established evidence

- The Windows relay is a Node.js process listening on loopback port `8788`.
- Port 443 is publicly exposed by Tailscale Funnel and forwards `/` to the relay. Other reported Tailscale ports are tailnet-only and **must not be changed or published**.
- Public `/healthz`, `/readyz`, protected-resource metadata and unauthenticated MCP challenges returned expected statuses.
- The public legacy MCP flow returned `initialize=200`, `notifications/initialized=202`, and `tools/list=200` with exactly `device`, `files`, `process`, `browser`, `desktop`, `batch`.
- None of these results proves ChatGPT accepts the authenticated tool catalog. The prior action-discovery failure remains independently unverified.
- Remote Desktop Commander access was limited by the provider's monthly quota. Do not attempt to bypass the quota. Remote deployment is not currently available through that channel.

## Architecture and compatibility contract

```text
ChatGPT -- OAuth authorization-code + PKCE S256
    |
    v
Tailscale Funnel :443 (same stable HTTPS origin)
    |-- /mcp, /.well-known/oauth-protected-resource*, /device, /healthz ... --> tether-relay :8788
    |-- OIDC discovery, auth/token/JWKS/registration/interaction paths        --> tether-auth :8790
    |-- /auth/device-login/* (longest-prefix exception)                        --> tether-relay :8788
    |
    v
tether-relay -- authenticated device WebSocket --> tetherd --> local Policy Broker
```

Use the **same stable HTTPS origin** for the self-hosted issuer and the MCP resource (which appends `/mcp`). Do not claim an unverified new subdomain, replace the existing root Funnel target, or convert existing tailnet-only ports to public. The auth process binds only to `127.0.0.1:8790`; relay stays on `127.0.0.1:8788`.

Tailscale's path-mount reverse proxy strips the mount prefix by default. Therefore a mounted route such as `/token` **must** target `http://127.0.0.1:8790/token` (not just port 8790), and a relay exception such as `/auth/device-login` must target `http://127.0.0.1:8788/auth/device-login`. Verify this behavior on the installed Tailscale version with a harmless route before production cutover; do not infer that a route succeeded merely from `tailscale funnel status`.

The actual OIDC route list is obtained from the locally served discovery document after `tether-auth` starts. Likely paths include `/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server`, `/auth`, `/token`, `/jwks`, `/reg`, `/interaction`, `/me`, and `/session`. Do not hardcode that candidate list into production without validating every advertised endpoint and the registration path; preserve `/auth/device-login/*` for the relay. Keep the root `/` relay handler unchanged.

## Verified staging entrypoint (Vaulter only)

The staging script is included on the feature branch and does **not** change the existing Auth0 relay or the Tailscale Funnel configuration.

From a PowerShell terminal on Vaulter with Git, Node.js >= 22 and pnpm 10 installed:

~~~powershell
$repo = Join-Path $env:USERPROFILE "source\Tetherplane"
if (-not (Test-Path -LiteralPath $repo)) {
    git clone https://github.com/muhamedsohaib/Tetherplane.git $repo
}
git -C $repo fetch origin feature/tether-auth-vaulter-migration-20261009
git -C $repo switch feature/tether-auth-vaulter-migration-20261009

& (Join-Path $repo "scripts\vaulter-tether-auth-stage.ps1")
& (Join-Path $repo "scripts\vaulter-tether-auth-stage.ps1") -Stage
~~~

The first script invocation is read-only and confirms repo identity, relay health, Node/pnpm versions, and free port 8790. The second verifies auth and relay package tests, creates new signer/bridge files under a protected user-local directory, and starts a local auth process at 127.0.0.1:8790. It checks readiness, discovery, PKCE, public-client token-exchange metadata and JWKS publication before reporting success. The process is intentionally **not installed as an autostart Windows service** in this staging phase. Do not reboot Vaulter and assume the staged process survives.

If port 8790 is occupied, the checkout is dirty, the protected state directory already exists, dependencies/tests fail, or local metadata is invalid, the script stops. It never rotates existing signing keys. It does not output credentials. After local staging, verify a safe process supervisor and backups before proceeding with public mounts or modifying the existing relay.

## Recovering a previously started local auth stage

If the test/build phase passed and the stage stopped at an OIDC metadata assertion after printing "Key material staged", **keep the original signing key, bridge credential, SQLite state, and configuration**. The loopback-only auth process is stopped by the error handler, but these persistent files are deliberately retained. Do not rerun plain -Stage and do not delete or replace those files.

After fetching the verified migration branch on Vaulter and checking that port 8790 is free:

~~~powershell
$repo = Join-Path $env:USERPROFILE "source\Tetherplane-auth-stage"
git -C $repo pull --ff-only
& (Join-Path $repo "scripts\vaulter-tether-auth-stage.ps1") -Stage -ReuseExistingState
~~~

The resume mode validates the existing private files, configuration, SQLite database and protected state directory. It fails closed if any required state is missing or inconsistent, and never regenerates the RSA signer or bridge credential. It re-runs the auth and relay tests, restarts the private loopback service, and validates proxied HTTPS OAuth metadata using only X-Forwarded-Host and X-Forwarded-Proto supplied to the loopback HTTP listener. Direct HTTP health checks remain separate from public-origin discovery checks.

The underlying OIDC provider's discovery endpoints may legitimately show http://127.0.0.1:<port>/auth if queried directly by an unproxied localhost client. The **trusted loopback proxy mode** must advertise the canonical public HTTPS origin for OAuth authorization, token, JWKS and registration URLs. That is the acceptance check. Do not replace this gate with a general relaxation of HTTPS or issuer matching.

All public Funnel mounting and relay OIDC issuer changes are **later phases** and must remain unchanged until the resumed stage finishes successfully.

## Required cutover gate

Before switching from Auth0, independently verify that a paired Tetherplane device is online and can approve the device-login proof, and inspect the existing relay's actual launch configuration and state-file path. Never infer these from port 8788 alone. Do **not** perform the public routing or relay cutover if this proof is unavailable. ChatGPT connector acceptance remains a separate final gate.

## Phase 0 — Read-only Vaulter preflight (before any service changes)

1. Identify the executable paths and current process management for the relay without printing command-line secrets, tokens, or auth configuration contents.
2. Confirm Windows Node.js >= 22, pnpm, git, the deployed Tetherplane code version, and the ability to run `auth/dist/cli.js`. Determine whether a fresh local build is necessary.
3. Confirm `127.0.0.1:8790` is unused; check resource availability and disk space for persistent SQLite/WAL.
4. Check whether any Tetherplane device is actually paired and **online** for device-assisted login approval. A valid token cannot be issued merely by entering an arbitrary account ID.
5. Save a private (non-Git) backup of the existing relay launch configuration, Auth0 OIDC metadata, device-registry state, and a **redacted** export of Tailscale routing. Never echo credentials, JWTs, JWKS private key fields, or registry secrets.
6. Confirm changes are restricted to Vaulter's auth/relay services; do not access Leno, Surface, or other computers via Remote Desktop Commander.

**Stop:** If the source/build is unknown or port occupied, stop local staging. Missing paired-device proof or missing backups blocks the **public relay cutover**, even if local auth staging succeeds.

## Phase 1 — Build and verify tether-auth offline

1. Use the canonical repository revision or an explicitly reviewed release to run:
   - `pnpm install --frozen-lockfile`
   - `pnpm --filter @tetherplane/auth build`
   - `pnpm --filter @tetherplane/auth test`
   - `pnpm --filter @tetherplane/auth typecheck`
   - `pnpm --filter @tetherplane/relay test`
2. Provision a persistent SQLite location and a generated signing JWKS with restrictive Windows file permissions, outside the Git repository. Do not dump or paste private key material. Use a supported local secret store or protected service configuration for the shared bridge credential.
3. Create auth deployment metadata with:
   - `issuer`: canonical public HTTPS **origin**;
   - `resource`: the same origin with `/mcp`;
   - `databasePath` and `jwksFile`: protected persistent local files;
   - `relay.url`: `http://127.0.0.1:8788`;
   - `relay.allowInsecureLocalhost`: `true` (loopback only);
   - `relay.bridgeTokenEnv`: the protected environment-variable **name** (not value).
4. Run `tether-auth` on `127.0.0.1:8790` using `--allow-insecure-localhost` only because TLS is terminated by the trusted same-host Funnel proxy.
5. Verify local health, readiness, discovery and JWKS signatures. Check metadata for S256, DCR, `offline_access`, public-client `none` token exchange, refresh-token support and correct issuer/resource. Do not publish the auth service until these checks pass.

**Stop:** If any protocol metadata, provider build, account-approval prerequisite or signing-key condition fails, preserve Auth0 and leave Funnel unchanged.

## Verified Vaulter local staging checkpoint — 2026-10-09

The user ran `-Stage -ReuseExistingState` on Vaulter after updating to feature-branch commit `5c2e24d`. **17/17 self-hosted auth tests and 72/72 relay tests passed**, and the script returned `tether-auth LOCAL STAGE VERIFIED` on `127.0.0.1:8790`. Existing signing material, bridge credential and SQLite state were reused without rotation. The Auth0 relay on `127.0.0.1:8788` and public Funnel routes remain unchanged. The reported auth process PID was `960` at that moment; **do not rely on the PID remaining stable**.

Before making any Tailscale route change, run this **read-only** routing diagnostic from the Vaulter PowerShell session:

~~~powershell
$repo = Join-Path $env:USERPROFILE 'source\Tetherplane-auth-stage'
git -C $repo pull --ff-only
& (Join-Path $repo 'scripts\vaulter-tether-auth-route-preflight.ps1')
~~~

It checks both loopback listeners, public and local relay health, public protected-resource metadata, HTTPS-proxied OIDC discovery endpoint paths and current Funnel mappings. Do not paste credentials, JWTs, raw JWKS files, raw Windows process command lines, or complete environment dumps. The diagnostic contains no writes or process disruption.

**Important Funnel rule:** The existing port 443 must remain in Funnel mode; using `tailscale serve` to reconfigure port 443 could make it tailnet-only. Do not run `tailscale funnel reset` or `tailscale funnel 443` to add auth routing. After a safe private backup of the exact current Serve/Funnel configuration, add only narrowly scoped `tailscale funnel --https=443 --set-path=...` mounts, validate actual installed-version path handling, and preserve existing `/` -> `127.0.0.1:8788`. At this point **no public OAuth mounts have been enabled**.

## Phase 2A — JWKS-only public Funnel canary (2026-10-09)

Vaulter read-only routing inspection passed with auth PID 960, relay PID 5904, all four private ports intact, canonical public issuer and unchanged Auth0 protected-resource metadata. The announced public OIDC endpoint paths were: `/auth`, `/token`, `/jwks`, `/reg`, `/token/revocation`, `/me` and `/session/end`.

**Only the JWKS path is authorized for the first public test.** The `/jwks` response contains public verification keys, not private signing keys.

~~~powershell
$repo = Join-Path $env:USERPROFILE "source\Tetherplane-auth-stage"
git -C $repo pull --ff-only

# Confirm current relay/auth reachability and Funnel baseline, without changes:
& (Join-Path $repo "scripts\vaulter-tether-auth-funnel-canary.ps1")

# Only after the above passes: add the JWKS-only route and verify it.
& (Join-Path $repo "scripts\vaulter-tether-auth-funnel-canary.ps1") -Apply
~~~

The apply phase writes the previous `tailscale funnel status --json` and human-readable routing status to protected local files under the already existing Tetherplane auth-state directory. It refuses to overwrite existing JWKS routing and requires the public MCP protected-resource issuer to remain Auth0. It invokes **only** `tailscale funnel --bg --https=443 --set-path=/jwks http://127.0.0.1:8790/jwks`, not a root-route replacement, `tailscale serve`, or a global reset.

It then checks public `/jwks` against the loopback signing **public key** attributes, confirms no private JWKS properties, checks the existing public `/healthz`, `/readyz`, `/.well-known/oauth-protected-resource/mcp` and confirms the pre-existing four tailnet-only ports remain unchanged. If any verification fails, it removes only the newly mounted `/jwks` route and checks rollback. If the original root route is unexpectedly missing after rollback, stop and review the protected status backup rather than resetting Funnel.

**Before publishing the rest of OAuth:** (1) verify the JWKS canary on the installed Tailscale version; (2) establish durable, restart-safe process supervision for `tether-auth`; (3) verify paired-device account-approval readiness and back up the relay's original process/registry launch config. The new public OAuth routes are `/auth`, `/token`, `/jwks`, `/reg`, `/me`, `/session`, `/interaction`, and narrow OIDC discovery mounts. `/auth/device-login` must be a more-specific mount to the existing relay: Tailscale ServeMux's matching can otherwise route device-login subpaths to the auth service. Never redirect the whole `/.well-known` or `/auth` prefix without preserving the protected-resource and device-login routes.

## Phase 2 — Publish only verified auth paths

1. Capture a safe Tailscale route configuration backup before changing any Funnel mount.
2. Add narrowly scoped `--https=443 --set-path=<verified-path>` mounts using paths derived from the local authorization-server metadata. Backend targets must restore the path that Tailscale strips.
3. Preserve root `/` -> relay :8788 and existing tailnet-only ports. Add a more specific `/auth/device-login` relay exception if mounting `/auth` to the auth process.
4. Verify each public provider endpoint against its loopback equivalent, including the same issuer, authorization endpoint, token endpoint, JWKS endpoint, DCR registration endpoint, interaction path and HTTPS redirects. Verify `/mcp`, protected resource discovery, and the six-tool listing remain unchanged.

**Stop:** Roll back only newly added mounts if a required provider URL fails or if any existing relay URL changes.

## Phase 3 — Switch the relay after device-proof readiness

1. Add `deviceLoginBridge.tokenEnv` to the relay's OIDC configuration and supply the same protected bridge credential to both services. This activates the device-assisted account proof endpoints.
2. Move the relay's OIDC verifier from Auth0 to `tether-auth`:
   - exact issuer match;
   - audience = stable public `/mcp` URL;
   - JWKS URI = self-hosted public JWKS endpoint;
   - scope includes `tetherplane:access`;
   - verified subject-based identity strategy with `principalPrefix`, preserving the existing account-to-device ownership.
3. Restart/reload the relay in the existing service manager only after auth is healthy and a rollback has been prepared. Use the **same** device registry state file and existing device credentials; do not re-pair devices gratuitously.
4. Confirm the relay's public health, OAuth resource metadata and unauthenticated six-tool listing now advertise the new issuer.
5. Perform a controlled device-assisted OAuth authorization-code + PKCE login, obtain a valid scoped bearer through the regular browser flow, verify authenticated status and local Policy Broker denial, then verify token refresh and revoked-token rejection.

**Stop and restore Auth0 relay config:** If service health, paired device ownership, proof flow, access-token claims or local policy gates fail.

## Phase 4 — ChatGPT acceptance and retirement

1. Relink the **single existing** ChatGPT Tetherplane connection as required by ChatGPT after the issuer changes. Reusing old Auth0 tokens is not a valid proof.
2. Observe the ChatGPT tool-registration request and error detail if it still fails; do not assume `tether-auth` resolves a separate tool schema/protocol problem.
3. Verify exact six tools, a harmless `device.status` call, a local-policy denial, reconnect, refresh, and revocation. Do not authorize external communication, financial operations, or disruptive foreground control.
4. Record live acceptance evidence. Only then retire Auth0 and its application configuration.

## Rollback and source-of-truth rules

- Before the switch, rollback means removing only auth-specific Funnel mounts; the existing relay stays on Auth0 and `/` remains unchanged.
- After the switch, revert the relay configuration to the backed-up Auth0 metadata and restart the existing relay service; retain paired devices and state. Revert auth-specific path mounts only after restoring the baseline protected-resource metadata. Verify `/healthz`, `/mcp`, and OAuth metadata.
- Keep JWKS private signing keys, bridge credentials, SQLite user tokens/state, and raw launch secrets outside Git, chat and logs.
- Keep six Compact MCP tools and policy boundaries unchanged. No canonical capability type may be named after an OAuth provider.
- No completion claim until live Vaulter and ChatGPT verification succeeds.

## Live deployment blockers at the time of writing

- Desktop Commander is quota-blocked; do not retry it.
- Vaulter's installed Tetherplane source/build location, process manager, Node/pnpm status, auth-port availability, and paired-device approval availability are not yet observed.
- There is no verified live self-hosted authorization service or ChatGPT acceptance run yet.
