# Safe setup — local first

Tetherplane is free and self-hostable. This skill is only guidance; it never installs, downloads, or edits host configuration by itself.

## Prerequisites

- A machine the operator owns/administers, with the cloned canonical Tetherplane repository.
- Rust toolchain from `rust-toolchain.toml`; Node.js 22+; pnpm 10; the MCP host supported by the operator.
- An operator-selected local folder eligible for the agent's explicit `--allow` roots, preferably a disposable test directory.
- Built `tetherd` and Compact MCP adapter binaries/files; do not assume they exist.

Install the prerequisite tools through their official instructions separately; this skill does not enable or change system-wide package-manager shims. From the Tetherplane repository root, **after the operator authorizes local dependency installation and building**:

```powershell
pnpm install --frozen-lockfile
cargo build -p tetherd
pnpm --filter @tetherplane/compact-mcp build
```

On Windows, configure the host's MCP stdio server **using actual absolute paths** to the existing executable and adapter, with arguments equivalent to:

```powershell
node adapters/compact-mcp/dist/stdio-server.js --tetherd target/debug/tetherd.exe --allow USER_APPROVED_DIRECTORY
```

The MCP host supplies its own server configuration; do not put the example literally into a machine-global configuration without checking paths, quoting, and user consent. On Linux/macOS the agent binary is `tetherd`, without `.exe`; support remains subject to actual platform testing.

Connect the host's MCP stdio transport, list the six tools, and run the read-only `device`/`status` example. Do not expand permissions merely because a test operation fails.

## Remote setup is separate

Local stdio works without hosted accounts. For remote use, consult the canonical `docs/remote/self-host.md` and current security/pairing documentation. Device authentication uses an outbound TLS WebSocket and the agent's existing securely stored credential reference. **Do not copy its value into chat, an environment dump, a skill file, or a listing.**

Prove an authenticated remote read-only invocation and a verified result before calling any remote device connected. Do not treat TCP connectivity as a substitute for authorization or RPC verification.
