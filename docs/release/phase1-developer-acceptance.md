# Phase 1 — developer-client first-use verification

**Scope:** OpenCode, Claude Code, Codex, one shared `tetherd`. This is a test/acceptance procedure, not a production installer. Current source of truth: `docs/live-acceptance.md`, `README.md`, `docs/remote/chatgpt-oauth.md`, `docs/release/three-channel-release-matrix.md`.

## 1. Stage, do not replace

Record source SHA, `tetherd` version, package SHA-256, Node version, signed Windows trust status, device OS/architecture and original installed state. Choose a **new authorized test machine or side-by-side test prefix** and temporary narrowly scoped root. Use an explicitly approved principal profile. Do not replace current scheduled tasks, mutate OAuth registration, pair new production devices or weaken Windows Smart App Control.

Existing Windows release smoke proves a **synthetic isolated** install and tool list. Draft PR #37 is a Linux **candidate** and does not yet provide a verified physical clean-machine installer.

## 2. Client configuration contract

Local compact server process:

```
node /absolute/path/adapters/compact-mcp/dist/stdio-server.js --tetherd /absolute/path/bin/tetherd --allow /absolute/approved/test-root --state-dir /absolute/test-state --principal-profile /absolute/approved-principal.json
```

Substitute the actual `tetherd.exe` path on Windows. Node, server, binary, root, state and principal files/paths must be resolved and verified; no token or device credential belongs in the client config. For **OpenCode V1**, use `mcp.tetherplane` with `enabled: true`; for **OpenCode V2**, use `mcp.servers.tetherplane` with `disabled: false` and `codemode: false` to expose the direct six-tool surface (the V2 default enables Code Mode). Select the observed client generation explicitly; do not assume V1 and V2 share a schema. For **Claude Code**, use its stdio `mcpServers.tetherplane` entry; for **Codex**, use `[mcp_servers.tetherplane]` TOML with `command` and `args`. The read-only preview generator in `scripts/release/phase1-client-profile.mjs` requires `--state-dir` and `--principal-profile` for every client, and `--opencode-schema v1|v2` for OpenCode. Verify the exact installed client version before adoption.

Keep agent state and the principal profile outside the allowed files root; they are security inputs, not agent-writable workspace artifacts. Preserve all existing user MCP entries. Do not blindly replace an existing config, modify clients in bulk or add a broad `--allow` root. Client registration/status commands are **not** real tool-call acceptance.

## 3. Actual-client verification (repeat per client)

1. Confirm the installed MCP server's `tools/list` advertises the six canonical tools: `device`, `files`, `process`, `browser`, `desktop`, `batch`. In each **actual named client**, verify the six tools remain visible under its own namespace convention; OpenCode V2 direct tools use prefixes such as `tetherplane_device`, not bare `device`. Do not mistake a client-side naming prefix for a missing MCP tool.
2. Call `device` with `op=status`. Verify returned real device ID, OS/arch, agent version and `background_only` policy mode.
3. Read an operator-created harmless fixture inside the temporary allowed root with `files` / `op=read`. Compare exact expected content.
4. Request read of a **nonexistent** path outside allowed root. Require `permission_denied`, not a fabricated success or content disclosure.
5. Observe approved test-device disconnect/reconnect. No mutation may be automatically replayed.
6. Uninstall/rollback the side-by-side candidate and verify unrelated paths and prior device state preserved. No `PurgeState` on current machines.
7. Record a stopwatch duration from clean install start to first client-originated status; target <= five minutes, **not** claimed achieved.
8. Obtain independent security/operability review of redacted evidence; a passing SDK smoke alone is insufficient.

## 4. Evidence receipt

Maintain a local `receipt.json` and `evidence/` text/JSON files. Record exact `source_commit`, `artifact_sha256`, `client` (name, version, stdio), `device` (id, OS, arch, agent version), UTC observation time, setup seconds, operator, different reviewer, and one hashed evidence file per gate.

Required all-platform gates: `source_artifact_integrity`, `clean_device_install`, `exact_six_tool_discovery`, `real_client_device_status`, `authorized_local_read`, `outside_root_permission_denied`, `restart_reconnect_without_replay`, `uninstall_rollback_state_preserved`, `independent_security_acceptance`.

Windows additionally requires `signed_binary_trust` and `background_human_coexistence`. Omit credentials, tokens, codes, authorization headers, private files and raw callback URLs.

**Fail closed:** missing/uncorroborated evidence, bad archive hash, wrong or undefined principal, OAuth scope expansion, unsigned Windows binary blocked by Smart App Control, client registration without real invocation, unexpected changes to user state, replay of a write, no independent reviewer, >300-second setup, or missing rollback all mean **NO-GO**.

Review each client/OS combination independently. No `v*` tag, protected merge or public listing until the complete applicable release gate receives explicit authorization.
