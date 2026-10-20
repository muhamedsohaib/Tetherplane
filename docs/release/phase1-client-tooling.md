# Phase 1 client profile tooling (review-only)

The scripts introduced by draft PR #38 **do not install Tetherplane, start tetherd, edit OpenCode/Claude/Codex settings, establish authorization, or publish any release**. They generate a preview and check a redacted evidence receipt. Only a separately authorized clean-device trial can verify real client behavior.

## Preconditions

Use an isolated approved **test machine** with Node.js 22+, a source-bound installed Tetherplane Compact MCP adapter, `tetherd`, an explicit allowed test directory, a separate state directory, and an operator-approved minimal principal profile. Use real absolute local paths. Do not pass tokens, passwords, code verifiers or device credentials.

The target adapter entry point is `adapters/compact-mcp/dist/stdio-server.js`. It accepts `--tetherd`, `--allow`, `--state-dir` and `--principal-profile`. The generated configuration launches that adapter with the Node.js executable that invoked the preview script, unless `--node` is supplied.

## Generate the read-only configuration preview

From the Tetherplane checkout:

```sh
node scripts/release/phase1-client-profile.mjs \
  --client opencode --opencode-schema v1 \
  --server /absolute/test-install/adapters/compact-mcp/dist/stdio-server.js \
  --tetherd /absolute/test-install/bin/tetherd \
  --allow /absolute/approved/test-root \
  --state-dir /absolute/separate/test-state \
  --principal-profile /absolute/approved/test-principal.json
```

Run the same command with `--opencode-schema v2` **only when the installed OpenCode is V2**. V1 uses `mcp.tetherplane` and `enabled: true`; V2 uses `mcp.servers.tetherplane`, `disabled: false` and `codemode: false`. Official docs: [OpenCode V1](https://opencode.ai/docs/mcp-servers/), [OpenCode V2](https://opencode.ai/v2/docs/mcp-servers), [migration](https://dev.opencode.ai/v2/docs/migrate-v1/).

For Claude Code change `--client` to `claude-code` and omit `--opencode-schema`. For Codex use `--client codex` and omit `--opencode-schema`. On Windows use the actual fully qualified `tetherd.exe` and normal Windows absolute paths; do not copy Unix paths verbatim.

**Review, don't overwrite:** the result is a standalone JSON/TOML fragment. Before inserting it in an existing client configuration, verify the installed client version and all existing MCP entries. Do not replace that configuration; do not silently widen the principal, allowed root or device permissions. The tool rejects missing paths, symlink paths, filesystem/home roots, missing explicit principal/state directory, state directories overlapping the allowed files root, and principal profiles within that root. These checks prevent accidental exposure of local authorization inputs through permitted file operations; local `tetherd` policy remains authoritative.

## Verify the real acceptance evidence

The operator separately performs every step in [phase1-developer-acceptance.md](phase1-developer-acceptance.md). Capture one redacted, distinct file per required gate, calculate SHA-256 for each, and reference it from `receipt.json` in the same directory:

```text
acceptance/
  receipt.json
  evidence/
    source_artifact_integrity.txt
    exact_six_tool_discovery.txt
    ...
```

After the **actual** tool invocations and independent review:

```sh
node scripts/release/check-phase1-evidence.mjs /absolute/acceptance/receipt.json
```

The checker requires a complete Windows/Linux gate set, a SHA-1 Git source commit string, SHA-256 package digest string, client/device metadata, UTC timestamp, measured time <=300 seconds, distinct operator and reviewer identities and unique SHA-256-matching evidence files. It fails if any required declaration is missing or changed.

Its only successful output is `PHASE1_EVIDENCE_FORMAT_VALID_UNVERIFIED` with `publication_authorized: false`: it checks receipt format and attachment integrity, **not** that a client truly operated, that the package digest belongs to the tested binary, that the recorded reviewer really signed off, or that the Tetherplane security model is audited.

## Test without real machines

```sh
node --check scripts/release/phase1-client-profile.mjs
node --check scripts/release/check-phase1-evidence.mjs
node --test tests/release/phase1-client-profile.test.mjs tests/release/check-phase1-evidence.test.mjs
```

The dedicated Windows/Ubuntu CI workflow runs these isolated synthetic checks with a read-only GitHub token; it does not deploy, sign, tag, publish, pair a device or run the actual OpenCode/Claude/Codex client.

**Release stays NO-GO** until independent real-device acceptance and the protected release publication gates are met and explicitly authorized.
