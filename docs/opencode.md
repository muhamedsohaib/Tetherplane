# OpenCode as a Tetherplane client

OpenCode is a reasoning and development client. Tetherplane remains the
execution and policy authority: OpenCode proposes, Tetherplane authorizes,
Tetherplane executes.

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

Environment-driven remote configuration:

```text
TETHERPLANE_MCP_URL       e.g. http://127.0.0.1:8788/mcp (loopback dev)
TETHERPLANE_CLIENT_TOKEN  static bearer from the relay --auth-config token_env
```

Canonical relay auth names (`token_env`, `account_id`, `client_id`,
`principal_id`) are defined in `docs/remote/self-host.md`. The example uses
`TETHERPLANE_CLIENT_TOKEN` as the `token_env` name, matching that document.

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

### Remote mode (RTX / Leno / Surface / VAULTER)

1. Self-host the relay per `docs/remote/self-host.md` (static bearer for
   controlled deployments; OIDC per `docs/remote/chatgpt-oauth.md` for
   production OAuth).
2. Pair each device (`POST /pair/start`, `POST /pair/approve`) and run
   `tetherd --relay-url ... --device-id <Leno|RTX|...>`.
3. Point OpenCode at the relay:

```jsonc
{ "mcp": { "tetherplane-relay": {
  "type": "remote",
  "url": "{env:TETHERPLANE_MCP_URL}",
  "enabled": true,
  "oauth": false,
  "headers": { "Authorization": "Bearer {env:TETHERPLANE_CLIENT_TOKEN}" }
} } }
```

`oauth: false` is required: the static-bearer relay is not an OAuth
authorization server and does not support dynamic client registration.

## Connecting and testing the connection

In OpenCode:

```text
opencode mcp list
opencode mcp debug tetherplane-relay
```

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
| `401` on connect | wrong/missing bearer | check `TETHERPLANE_CLIENT_TOKEN` matches relay `token_env` |
| `permission_denied` | local policy or cross-account | check `--allow` roots, principal profile, device ownership |
| `disconnected` | device offline | wait/retry with backoff; movable tasks go elsewhere, machine-bound tasks keep job state and report a blocker |
| `capability_unavailable` | unknown device or missing provider | check pairing / `GET /devices`, provider install |
| `foreground_lease_required` | GUI action without human grant | use DOM/CLI path, or request human approval |
| `approval_required` | destructive class | obtain local approval; never weaken policy to pass |

## Security model

- Secrets live in environment variables or the host secret store, never in
  Git, configs, logs, fixtures, or screenshots.
- The relay authenticates account/client; the device's launch-bound local
  principal authorizes. Relay identity cannot expand local roots or
  capabilities.
- `background_only` default; human-owned tabs, windows, and processes are
  protected; agent-owned resources are created, never seized.
- Mutations should carry `idempotency_key` so relay reconnects never
  double-execute.

## Verification

Contract coverage lives in `tests/e2e/opencode-contract.test.ts` and
multi-node mobility in `tests/e2e/opencode-mobility.test.ts`. Run them with
the e2e suite (`pnpm.cmd --filter @tetherplane/e2e test`). They prove,
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
