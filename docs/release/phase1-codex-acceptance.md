# Codex Phase 1: repeatable existing-install acceptance (draft)

**NOT a release, installer, signing bypass, device pairing workflow, or human approval.** This runbook replays the read-only Surface Codex acceptance observed on October 21, 2026. It is an intermediate acceptance harness pending independently verified clean-machine installation and signing.

## What is proved

Against an **already installed, explicitly authorized** Tetherplane and an already logged-in Codex CLI, the harness can establish:

1. One effective Codex MCP server in a command-line-only session, without editing `~/.codex/config.toml` or copying API keys/auth files.
2. A disposable local stdio Compact MCP adapter with a new test-only principal limited to `device.status` and `filesystem.read` for the named device and a temporary test root.
3. Three **model-originated** MCP calls, independently checked from Codex JSONL events: status, successful fixture read, and expected outside-root `permission_denied`. No other MCP calls, built-in command executions, file changes or web tool events may occur.
4. Saved Codex configuration hash unchanged and test-owned directory removal.

The script is `scripts/release/phase1-codex-acceptance.mjs` and requires Node.js 22+ and an existing Codex CLI authenticated account. The script does **not** install Codex, download binaries, modify Task Scheduler, change OAuth/DCR, touch other devices, or use Tetherplane `process.terminate`.

## Preconditions

- Operator **explicitly** authorizes testing on the named machine. Never run using production privileged principal credentials.
- Installed `tetherd`, the matching Compact stdio MCP adapter, Node.js and Codex CLI exist at absolute paths; installed hash and code-signature are separately verified. A passing result **does not** imply Windows Authenticode trust.
- Codex authentication is already valid. No credentials are copied or linked; an isolated `CODEX_HOME` generally has no login. Existing Codex home remains in place, but effective MCP configuration is bounded by session-local `-c` overrides.
- The test runs through Codex `--approve-for-me` **only when explicitly selected**, because headless `codex exec` with approval policy `never` rejected the six generic tools. `--approve-for-me` cannot be combined with `--sandbox read-only` on tested Codex `0.162.1`. Codex's review automation **is not human consent**, and its workspace-write runtime is not the same as a read-only OS sandbox. Tetherplane's **local principal policy** remains the decisive authorization boundary. The harness rejects any observed shell or mutating-tool events after the fact; do not mistake event verification for a preventative OS sandbox.
- Never annotate entire general-purpose tools (`files`, `process`, `device`) as unconditionally read-only, loosen approval policies, or bypass permissions to make this pass.

## Run against an existing Windows installation

Use a **trusted copy from the reviewed GitHub commit**. Do not run an unpinned remote script or substitute a local unreviewed binary. On Surface, installed paths observed October 21 were:

```powershell
$prefix = Join-Path $env:LOCALAPPDATA 'Programs\Tetherplane'
$node = (Get-Command node.exe).Source
$codex = (Get-Command codex.exe).Source
$adapter = Join-Path $prefix 'adapters\compact-mcp\dist\stdio-server.js'
$agent = Join-Path $prefix 'bin\tetherd.exe'

node scripts/release/phase1-codex-acceptance.mjs `
  --codex $codex --node $node --adapter $adapter --tetherd $agent `
  --device Surface --mode preflight
```

Preflight lists Codex's existing MCP registrations *in memory*, creates temporary isolated state and principal, applies **transport-correct** session-only disabled entries, verifies the trial is the sole enabled server, then cleans up. It must return `PREVIEW_ONLY_NOT_MODEL_ACCEPTANCE`; it does not invoke a model.

Run the real test **only with explicit operator approval** for Codex's automatic-review mode:

```powershell
node scripts/release/phase1-codex-acceptance.mjs `
  --codex $codex --node $node --adapter $adapter --tetherd $agent `
  --device Surface --mode run --approval auto-review `
  --timeout-sec 110
```

Optional: add `--expected-agent-sha256` with a separately trusted hash. The exact installed Surface agent observed in the October 21 trial had SHA-256 `4f06b70ca4eefb2c1c5cfb70da71e1da45d02ece54d3f96b1220e16edcb2102a`; it was **unsigned**, so do not claim a signed-kit pass. For a local sanitized report, supply `--evidence-out` pointing to a **new file in an existing directory**; the harness will not overwrite one. It does not retain raw Codex events or authorization data.

## Interpretation and recovery

A passing receipt has `status=FUNCTIONAL_CLIENT_ACCEPTANCE`, `model_client_success=true`, three ordered tool results, fixture and denial evidence, zero unexpected MCP/shell events, unchanged Codex config, and `test_owned_directory_removed=true`. It deliberately includes `publication_authorized=false`, `clean_install_proven=false`, and `signed_windows_binary_proven=false`. **Do not** paste raw logs, tokens, private paths or full Codex MCP inventories into public issues.

If the model takes longer than 110 seconds, Node terminates the **test-owned Codex child** through its bounded subprocess mechanism; the harness attempts cleanup and returns `NO_GO`. If a child unexpectedly survives and local policy denies `process.terminate`, stop and obtain operator-assisted cleanup; do not use a different tool to evade that denial.

Codex may make a different number/order of tool calls across model versions. Record the NO-GO result and inspect the client/tool contract rather than weakening the assertions.

## Test without a real model

```shell
node --check scripts/release/phase1-codex-acceptance.mjs
node --test tests/release/phase1-codex-acceptance.test.mjs
```

GitHub Actions executes these synthetic negative-contract tests on Ubuntu and Windows using only a read-only checkout token. It does not run authenticated Codex, use existing machine credentials, sign binaries, publish artifacts, touch a production device, or prove release readiness.

## Remaining gates

- Repeat against independently reviewed version-pinned clean installation and a **trusted signed Windows kit** (Windows 11 signing/Smart App Control is not tested by Surface Windows 10).
- Measure clean install to first tool-originated status (<5-minute *target*, not yet measured).
- Demonstrate safe authenticated reconnect, bounded network fault tolerance and state-preserving uninstall/rollback without disabling Tailscale adapters.
- Obtain independent human security review and separate approval for mainline merge, release tags and public distribution. Preserve the four-device architecture and existing OAuth clients.

Related: [PR #38](https://github.com/muhamedsohaib/Tetherplane/pull/38), [PR #39](https://github.com/muhamedsohaib/Tetherplane/pull/39), [issue #41](https://github.com/muhamedsohaib/Tetherplane/issues/41).
