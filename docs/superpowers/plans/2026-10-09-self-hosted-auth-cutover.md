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

## JWKS canary accepted — 2026-10-09

Vaulter confirmed the `-Apply` canary using the actual installed Tailscale Funnel. The user-provided run reported:

- Original 443 Funnel root remained `/ -> http://127.0.0.1:8788`.
- Public `/jwks` proxies to `http://127.0.0.1:8790/jwks`.
- The public JWKS public-key members match the local authorization-server public keys.
- Public MCP health and the Auth0 protected-resource issuer remained unchanged.
- Existing tailnet-only ports `10000`, `8443`, `9443`, and `9445` remained unchanged.
- A protected on-Vaulter backup of the original Funnel configuration was created.

**Do not run the global `tailscale funnel --https=443 off` suggestion from the CLI output**: it could disable the entire public port, not just the canary mount. If the JWKS canary must be removed, use only `tailscale funnel --https=443 --set-path=/jwks off` after checking its preexisting state.

The next migration gate is the **read-only** process/device readiness inspection:

~~~powershell
$repo = Join-Path $env:USERPROFILE "source\Tetherplane-auth-stage"
git -C $repo pull --ff-only
& (Join-Path $repo "scripts\vaulter-tether-auth-cutover-readiness.ps1")
~~~

This discovers the running relay's exact (nonsecret) launch-file paths, checks whether the paired-device registry can be located, and reports whether the auth process has a direct service association or a candidate Windows Scheduled Task. It never prints command lines, bearer values, account IDs, credentials, registry hashes or private JWKS fields. **A paired record does not establish that its device is currently online.** Device-assisted login approval must be tested separately before the relay issuer switch.

The current `tether-auth` instance was launched by a one-time staging command and is **not yet verified restart-safe**. Keep auth login and token routes private until restart supervision and path-exception deployment are designed from the running environment. A successful JWKS-only public canary does not mean the authorization server is production-ready.

## Readiness evidence after public JWKS canary

The user ran the Vaulter read-only cutover readiness script after updating to commit `4ae6d81`. Observed results:

- Relay and authorization server were healthy on loopback `8788` and `8790`.
- The Funnel root and `/jwks` mounts remained unchanged.
- The current relay's `--auth-config` and `--state-file` paths were both found; the present relay issuer is Auth0, and its OAuth audience matches the public `/mcp` resource.
- The registry contained **4 non-revoked paired records**, with a matching account ID in an existing OIDC identity binding.
- Neither the relay (PID 5904) nor the staged authorization server (PID 960) was directly associated with a Windows service.
- The Windows Task Scheduler query found **2 named Tetherplane candidate tasks**, but the task actions/triggers and whether either process is supervised were not yet inspected.
- **No actual online device or completed device-assisted approval was proven.** The stable pairing record alone is not enough to switch the identity provider.

Next **read-only** command on Vaulter to classify scheduled tasks without disclosing task command lines, task identities, bridge credentials, JWTs, or relay device credentials:

~~~powershell
$repo = Join-Path $env:USERPROFILE "source\Tetherplane-auth-stage"
git -C $repo pull --ff-only
& (Join-Path $repo "scripts\vaulter-tether-auth-supervision-preflight.ps1")
~~~

Do not configure a second task or a Windows service until existing task roles, trigger type, execution time limit, account-logon mode, and restart settings have been inspected. Some scheduler tasks only launch at interactive logon, and some have a default maximum execution time unsuitable for a persistent auth server. The diagnostic does not restart either running process.

## Vaulter logon-task evidence — 2026-10-09

The user ran `vaulter-tether-auth-supervision-preflight.ps1` after commit `1e08c69`. Both loopback Node listeners were present (relay PID 5904, auth PID 960), and the two Tetherplane-named Scheduled Task candidates reported:

| Observation | Candidate 1 | Candidate 2 |
| --- | --- | --- |
| Task state | Running | Ready |
| Enabled | Yes | Yes |
| Trigger | logon | logon |
| Role recognized in task action | unclassified | unclassified |
| RestartCount | 999 | 0 |
| StartWhenAvailable | True | False |
| ExecutionTimeLimit | unlimited | limited |
| LastTaskResult | nonzero (not yet interpreted) | nonzero (not yet interpreted) |
| LogonType | unknown (old inspector did not handle all CIM enum values) | unknown |

Neither task is confirmed to launch the relay or the staged auth process, and neither includes a reported boot trigger. **Do not interpret `lastResult=nonzero` as an error without examining Task Scheduler status codes**; `0x41301`, for instance, is a normal running status.

The inspector has been updated to classify launchers without exposing task arguments, recognize ScheduledTasks principal logon enums, and distinguish normal nonzero task-result statuses. Run the updated read-only inspector before choosing a deployment identity or changing scheduling:

~~~powershell
$repo = Join-Path $env:USERPROFILE "source\Tetherplane-auth-stage"
git -C $repo pull --ff-only
& (Join-Path $repo "scripts\vaulter-tether-auth-supervision-preflight.ps1")
~~~

The intent is a **separate restart-safe auth process** under a principal with access to the protected SQLite/JWKS/bridge-secret files. Do not blindly reuse the currently running candidate task or install a duplicate scheduler task. A user-logon-triggered task does not establish unattended boot operation. The follow-on installer must never place any bridge token, private JWKS field, OAuth cookie/token or device secret in task action arguments, logs or Git.

## Restart-safe auth supervision — staging design (2026-10-09)

The updated Vaulter task preflight reported two existing, unclassified PowerShell-wrapper tasks:

- Candidate 1: **running**, `logon` trigger, requires user session, `RestartCount=999`, start-when-available, unlimited runtime, Task Scheduler last result **running**.
- Candidate 2: **ready**, `logon` trigger, requires user session, `RestartCount=0`, no start-when-available, limited runtime, Task Scheduler last result **nonzero-other**.

Neither has been identified as the authorization server and neither runs on system startup. **Do not modify or reuse them based only on those names and status fields.**

A deliberately separate `Tetherplane-TetherAuth-Startup` task can be staged without touching these tasks. It runs as the **existing signing-state owner** through Windows Task Scheduler S4U, with the lowest run level (not LocalSystem, no stored Windows password), a startup trigger, restart attempts, unlimited running time and singleton execution. The identity's batch-logon privilege, local file access, and local HTTP availability must be demonstrated on Vaulter first. S4U has documented limitations: no network credentials and no access to EFS-encrypted files. Do not infer working connectivity from a CI simulation.

From the existing Vaulter PowerShell session after updating to the verified feature branch:

~~~powershell
$repo = Join-Path $env:USERPROFILE 'source\Tetherplane-auth-stage'
git -C $repo pull --ff-only

# 1. Read-only state and collision check.
& (Join-Path $repo 'scripts\vaulter-tether-auth-autostart.ps1')

# 2. Create/run/remove only a unique temporary S4U task.
#    It verifies read permission to the existing JWKS, bridge-file and SQLite
#    state, Node runtime compatibility, and both local health endpoints.
& (Join-Path $repo 'scripts\vaulter-tether-auth-autostart.ps1') -Probe

# 3. Only after successful S4U proof, repeat it and register a new DISABLED
#    startup task (does not launch or stop either live Node process).
& (Join-Path $repo 'scripts\vaulter-tether-auth-autostart.ps1') -Register
~~~

The permanent task executes a copy of `vaulter-tether-auth-startup-runner.ps1` located inside the existing ACL-protected auth-state directory, not a mutable PowerShell script path in the repository. Its task action includes **paths only**; the runner reads the current bridge secret directly from the protected file into its process environment at service start. No task action contains the bridge token or private JWKS contents.

**Important:** Registration deliberately leaves the new task disabled to avoid competing with the healthy manually staged auth process at `127.0.0.1:8790`. The task therefore does **not yet provide live restart supervision**. Do not reboot and presume it will start until a separately implemented and tested activation/rollback procedure has stopped only the verified staged auth instance, enabled and started the task, and verified service continuity. Do not overwrite the 2 existing logon tasks, disable Auth0, or expand public OAuth routes during this stage.

If `-Probe` fails due to S4U rights or local access, stop. Do not fall back to running the public authorization server as SYSTEM, weaken state-file ACLs, or put Windows account passwords/bridge credentials into task arguments. Record sanitized failure categories and assess an appropriate dedicated low-privilege service identity.

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
