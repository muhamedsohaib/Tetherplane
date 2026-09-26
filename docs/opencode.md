# OpenCode as a Tetherplane client

OpenCode is a reasoning and development client. Tetherplane remains the
execution and policy authority: OpenCode proposes, Tetherplane authorizes,
Tetherplane executes.

Live production architecture:

```text
OpenCode
  -> Auth0 OIDC (Native client, scope tetherplane:access)
  -> VAULTER Tetherplane hybrid-auth relay (static + OIDC)
  -> paired remote device (outbound device WebSocket)
  -> tetherd local principal/policy (final authority)
```

Live public relay:

```text
https://vaulter.tailf65eba.ts.net:10000/mcp
```

Loopback relay listener (VAULTER, TLS terminated by proxy or local dev):

```text
127.0.0.1:8788
```

The hybrid relay accepts BOTH explicitly bound OIDC access tokens and
existing static bearer clients. OIDC requires an exact
subject/client binding; wildcard subjects or client IDs are rejected.
Static bearer remains supported only for controlled self-host cases.

Architecture:

```text
OpenCode
   |
   v
Tetherplane MCP (exactly six tools: device, files, process, browser, desktop, batch)
   |
   +-- local:  OpenCode -> compact-mcp stdio adapter -> tetherd --stdio-rpc
   +-- remote: OpenCode -> tether-relay Streamable HTTP (/mcp) -> device WebSocket -> tetherd
   |
   v
Authorized Tetherplane nodes (RTX, Leno, Surface, VAULTER)
```

No adapter code was needed: OpenCode has stable native MCP support for both
`local` (stdio) and `remote` (Streamable HTTP) servers, and Tetherplane
exposes the same six-tool surface on both transports. This integration is
configuration plus contract tests. Tetherplane stays client-neutral; the
ChatGPT/Codex/Claude integrations are untouched.

## Prerequisites

- This repository built: `cargo build -p tetherd` and the TypeScript
  workspaces (`pnpm.cmd install`, then the `tests/e2e` pretest builds deps).
- Node.js 22+ and pnpm 10 (see README.md).
- OpenCode installed separately (not vendored here).

## Configuration

Copy the section you need from `opencode.tetherplane.example.jsonc` into
your `opencode.json` / `opencode.jsonc`. Never commit real tokens.

The example keeps three paths:

- `tetherplane-local`: local stdio authority (optional/local path).
- `tetherplane-relay`: recommended remote production path over
  OIDC/hybrid auth (OAuth discovery, no static bearer).
- `tetherplane-relay-static`: bearer/static fallback for controlled
  self-host cases only (`oauth: false` + `Authorization` header).

Production OIDC identifiers (public, non-secret):

```text
Auth0 Native client: cddeYEWkobslw55zl2dFXkG8RZq1Yr8Y
Audience (OAuth resource): https://limits-goals-drove-subsidiary.trycloudflare.com/mcp
Scope: tetherplane:access
Public MCP: https://vaulter.tailf65eba.ts.net:10000/mcp
```

The audience is the canonical HTTPS MCP resource URL configured on the
relay (`oauth.resource`). It must match the relay `oidc.audience` exactly.
The issuer must match provider discovery exactly, including any trailing
slash. Tokens must be RS256, unexpired, carry all configured scopes, and
match an explicitly bound subject/client pair. Unknown identities fail
closed. JWT account/principal claims never override the configured binding.

Environment-driven static fallback configuration:

```text
TETHERPLANE_MCP_URL       e.g. http://127.0.0.1:8788/mcp (loopback dev)
TETHERPLANE_CLIENT_TOKEN  static bearer from the relay --auth-config token_env
```

Canonical relay auth names (`token_env`, `account_id`, `client_id`,
`principal_id`) are defined in `docs/remote/self-host.md`. The static
example uses `TETHERPLANE_CLIENT_TOKEN` as the `token_env` name, matching
that document.

### Local mode (one machine)

```jsonc
{ "mcp": { "tetherplane-local": {
  "type": "local",
  "command": ["node",
    "<repo>\\adapters\\compact-mcp\\dist\\stdio-server.js",
    "--tetherd", "<repo>\\target\\debug\\tetherd.exe",
    "--allow", "C:\\path\\you\\explicitly\\allow"],
  "enabled": true
} } }
```

Local policy (allowed roots, launch-bound principal, `background_only`)
is enforced by the local `tetherd`; OpenCode cannot widen it.

### Remote mode, production OIDC (recommended)

1. The VAULTER relay already runs hybrid auth per
   `docs/remote/chatgpt-oauth.md` (static `clients` + `oidc` in the same
   `--auth-config`; OIDC and static `clientId` values must not collide).
2. Pair each device (`POST /pair/start`, `POST /pair/approve`) and run
   `tetherd --relay-url ... --device-id <Leno|RTX|...>`. Pairing binds a
   locally generated device credential hash to an existing relay account.
   The raw credential never leaves the device. Revocation is
   `POST /devices/<device-id>/revoke`.
3. Point OpenCode at the public relay with OAuth discovery enabled
   (do NOT set `oauth: false` on this entry):

```jsonc
{ "mcp": { "tetherplane-relay": {
  "type": "remote",
  "url": "https://vaulter.tailf65eba.ts.net:10000/mcp",
  "enabled": true
} } }
```

For most OAuth-enabled servers no extra OAuth block is needed. OpenCode
discovers the authorization server from the relay
`/.well-known/oauth-protected-resource` metadata, uses PKCE, and prompts
for browser login on first use (`opencode mcp auth tetherplane-relay`
or `/mcps` in the TUI). Tokens are stored by OpenCode in
`mcp-auth.json`, never in this repository.

Pre-registered production client (required because the relay forbids
wildcard/dynamic clients). Use this when OpenCode would otherwise attempt
dynamic client registration:

```jsonc
{ "mcp": { "tetherplane-relay": {
  "type": "remote",
  "url": "https://vaulter.tailf65eba.ts.net:10000/mcp",
  "enabled": true,
  "oauth": {
    "clientId": "cddeYEWkobslw55zl2dFXkG8RZq1Yr8Y",
    "scope": "tetherplane:access"
  }
} } }
```

No client secret is configured for this public Native client. Do not allow
arbitrary dynamically registered clients by wildcard. Ensure the bound
subject/client pair exists in the relay `oidc.bindings`; an unbound but
otherwise valid token fails closed.

### Remote mode, static bearer fallback (controlled self-host only)

1. Self-host the relay per `docs/remote/self-host.md` (static bearer for
   controlled deployments; OIDC per `docs/remote/chatgpt-oauth.md` for
   production OAuth).
2. Pair each device (`POST /pair/start`, `POST /pair/approve`) and run
   `tetherd --relay-url ... --device-id <Leno|RTX|...>`.
3. Point OpenCode at the relay with automatic OAuth disabled:

```jsonc
{ "mcp": { "tetherplane-relay-static": {
  "type": "remote",
  "url": "{env:TETHERPLANE_MCP_URL}",
  "enabled": true,
  "oauth": false,
  "headers": { "Authorization": "Bearer {env:TETHERPLANE_CLIENT_TOKEN}" }
} } }
```

`oauth: false` is required on this static-bearer entry only: the
static-bearer relay is not an OAuth authorization server and does not
support dynamic client registration.

## Connecting and testing the connection

In OpenCode:

```text
opencode mcp auth tetherplane-relay
opencode mcp list
opencode mcp debug tetherplane-relay
```

For the OIDC production entry, `mcp auth` opens the Auth0 browser login
for the Native client above. For the static fallback entry, no browser
login is used; the bearer comes from `TETHERPLANE_CLIENT_TOKEN`.

Then prompt, for example: `use the tetherplane tools to list devices`.
Device discovery uses the `device` tool (`op: status`, `op: capabilities`);
never hard-code device IDs. The relay resolves `device_id` (`Leno`, `RTX`,
) to the currently-online paired device for your account; unknown,
cross-account, or offline devices return `capability_unavailable`,
`permission_denied`, or `disconnected` respectively.

## Invoking tools

All six tools take `{ op, args, device?, job_id?, response_mode?,
idempotency_key? }`. Per-operation schemas are discoverable at runtime:

```text
device with op=schema, args={namespace, operation}
```

Examples:

```text
Check all Tetherplane devices.                       -> device status/capabilities
Run the Project ZERO tests on Leno.                  -> process run (device: Leno)
Compare this file on Leno against VAULTER's copy.    -> files read (device: Leno), files read (device: VAULTER)
Execute these jobs on RTX and Leno in parallel.      -> batch execute (parallel)
```

Prefer native API -> filesystem -> process/CLI -> browser DOM -> desktop GUI.
Desktop GUI automation is last resort and requires a human-granted
`ForegroundLease`; OpenCode can never self-authorize one.

## RTX model routing

Two independent paths, deliberately separated:

- **Reasoning inside OpenCode**: point OpenCode at RTX-hosted models via
  the `rtx-ollama` provider in the example config (OpenAI-compatible
  `baseURL` + model ids from `ollama list` on RTX). Swap models in config;
  Tetherplane is untouched.
- **Model-driven Tetherplane actions** (automation): the existing
  `@tetherplane/model-client` (`OpenAICompatibleModelClient` +
  `ModelController`) takes any OpenAI-compatible `endpoint` + `model` and
  emits canonical invocations that Tetherplane authorizes as usual. Model
  output cannot smuggle `principal_id`, credentials, or policy overrides;
  unknown fields are rejected before dispatch.

The router may choose coding/reasoning/vision/embedding models per task.
It never decides whether an OS action is authorized.

## Multi-machine workflows

Use durable jobs (`device` `job_create` / `job_get` / `job_checkpoint` with
`target_device` and `permitted_principals`) so long-running work survives
OpenCode session loss, and `batch execute` for parallel fan-out. Share one
task/job ID across machines for tracing.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `needs authentication` / `401` on OIDC connect | OpenCode has no OIDC token yet, or token expired/unbound | run `opencode mcp auth tetherplane-relay`, complete Auth0 login, retry; check subject/client binding and `tetherplane:access` scope |
| `401` on static connect | wrong/missing bearer | check `TETHERPLANE_CLIENT_TOKEN` matches relay `token_env` |
| `mcp/www_authenticate` error result on `tools/call` | anonymous discovery session, no valid bearer | authenticate first; discovery alone (`tools/list`, `ping`, `notifications/initialized`) never executes tools |
| `permission_denied` | local policy or cross-account | check `--allow` roots, principal profile, device ownership |
| `disconnected` | device offline | wait/retry with backoff; movable tasks go elsewhere, machine-bound tasks keep job state and report a blocker |
| `capability_unavailable` | unknown device or missing provider | check pairing / `GET /devices`, provider install |
| `foreground_lease_required` | GUI action without human grant | use DOM/CLI path, or request human approval |
| `approval_required` | destructive class | obtain local approval; never weaken policy to pass |

## Security model

- Secrets live in environment variables or the host secret store, never in
  Git, configs, logs, fixtures, or screenshots.
- The relay authenticates account/client (static bearer or explicit OIDC
  binding); the device's launch-bound local principal authorizes. Relay
  identity cannot expand local roots or capabilities. Remote identity is
  provenance only.
- OIDC explicit binding is required: only configured subject/client pairs
  map to a relay identity. No wildcard auth. Conflicting `azp`/`client_id`,
  wrong audience/issuer, expiry, or missing scope fails closed.
- Local principal remains final authority: `AgentRuntime` replaces the
  incoming principal with the launch-bound local principal before policy
  evaluation.
- Pairing model: device generates a local credential, relay stores only its
  SHA-256 hash plus account/device binding after human approval of the
  short pairing code. Raw device credentials never leave the device.
- `background_only` default; human-owned tabs, windows, and processes are
  protected; agent-owned resources are created, never seized.
- Mutations should carry `idempotency_key` so relay reconnects never
  double-execute.

## Verification

Contract coverage lives in `tests/e2e/opencode-contract.test.ts` and
multi-node mobility in `tests/e2e/opencode-mobility.test.ts`. Relay hybrid
static+OIDC coverage lives in `relay/test/hybrid-auth.test.ts` alongside
`oidc-auth`, `oauth-edge`, `oauth-config`, and `mcp-http` tests. Run them
with the e2e suite (`pnpm.cmd --filter @tetherplane/e2e test`). They prove,
through the same MCP transports OpenCode uses:

- session init plus exactly the six expected tools;
- device discovery and `background_only` status;
- permitted file read and process start;
- agent-owned browser page use plus human-owned mutation denial;
- remote bearer auth, cross-account isolation, offline (`disconnected`)
  handling, and authentication-failure rejection;
- foreground-lease approval gate (`permission_denied` on self-grant,
  `foreground_lease_required` on unleased pointer movement);
- RTX-style OpenAI-compatible model proposing actions that Tetherplane
  authorizes, with principal-smuggling rejected.
- One-session mobility across RTX, Leno, Surface, and VAULTER: registry
  discovery, per-node status, a seed -> derive -> persist -> execute ->
  aggregate workflow that moves information between nodes without
  reconnecting, a target-node `permission_denied` on VAULTER process
  execution, post-revocation isolation, raw-offline `disconnected`
  reporting, and movable-task retargeting.

The e2e tests resolve the agent binary from `TETHERPLANE_TETHERD_PATH` when
set, falling back to `target/debug/tetherd(.exe)`. Set it when host policy
(for example Windows Application Control) blocks execution under the
repository `target/` directory:

```powershell
$env:TETHERPLANE_TETHERD_PATH = "<allowed-path>\tetherd.exe"
```
