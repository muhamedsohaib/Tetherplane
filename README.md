# Tetherplane

Tetherplane is an open-source control plane for AI-operated computers. It gives AI clients a small, provider-neutral interface for files, processes, browsers, desktop UI, batching, local policy, durable jobs, and optional remote routing.

The local agent is the final authority. Remote relays and AI clients can route requests, but they cannot override stricter local policy.

## Default AI-facing surface

Compact MCP exposes exactly six tools:

- device
- files
- process
- browser
- desktop
- batch

Operations are selected with an op field rather than exposing dozens of model-visible tools.

## Architecture

Tetherplane keeps these boundaries separate:

- Capability Kernel — canonical invocation/result protocol, policy, response budgets, handles, ownership.
- Providers — filesystem/search/process/browser/desktop implementations.
- Adapters — Compact MCP, model-neutral JSONL client, RDC compatibility.
- Transport — local stdio and optional relay/WebSocket routing.
- Policy Broker — local principal grants, allowed roots, approval classes, human-coexistence rules.

The browser and Windows desktop implementations prefer semantic control before physical control. Human-owned resources are protected by default.

## Local quick start

Development requires the Rust toolchain from rust-toolchain.toml, Node.js 22+, and pnpm 10.

Build and test with:

    corepack enable
    corepack prepare pnpm@10 --activate
    pnpm install --frozen-lockfile
    cargo test --workspace
    pnpm -r typecheck
    pnpm -r test
    pnpm -r build

Start the Compact MCP edge from the repository after building:

    node adapters/compact-mcp/dist/stdio-server.js --tetherd target/debug/tetherd.exe --allow C:\path\you\explicitly\allow

## Windows release package

Build a runtime package:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows.ps1 -OutputPath .\dist\Tetherplane-Windows-x64

Install per-user into an explicit prefix:

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1 -PackagePath .\dist\Tetherplane-Windows-x64 -InstallPrefix "$env:LOCALAPPDATA\Programs\Tetherplane" -StateDir "$env:LOCALAPPDATA\Tetherplane\state"

Ordinary uninstall removes installed binaries but preserves state. State purge requires the explicit -PurgeState switch and is only allowed for state created by the installer.

The Windows Compact MCP edge requires a system Node.js runtime. Runtime package dependencies are staged with the release package; pnpm is not required at runtime.

## Remote mode

tether-relay provides pairing, account/device routing, Streamable HTTP MCP, outbound device WebSockets, revocation, and reconnect isolation. Production direct relay transport requires HTTPS/WSS. Plain HTTP/WS is restricted to explicit loopback development mode.

See docs/remote/self-host.md and docs/security/remote-plane.md.

## Browser and desktop coexistence

Browser automation uses extension-first authenticated-profile operation with isolated CDP fallback. Human-owned tabs are not navigated or closed in background mode.

Windows desktop automation uses UI Automation semantic patterns. Invoke, Value, Selection, Toggle, Expand, and Collapse do not require physical pointer movement. Physical fallback is isolated behind scoped, expiring ForegroundLeases and recent human activity can block it.

See docs/security/threat-model.md and docs/recovery.md.

## Compatibility

A separate RDC-shaped compatibility endpoint maps legacy core workflows to canonical Tetherplane semantics without changing the six-tool Compact MCP interface. See docs/compatibility/rdc.md.

## Measured performance

Measured values are published under docs/benchmarks/. They are evidence from named machines, not marketing claims.

The original Leno baseline met the idle-memory target but missed the original cold-start target. That historical miss is retained honestly. The fresh Plan F release-candidate measurement at canonical commit `c1ea567c09fe2a0244ff12db2864cf309e0fedaf` recorded a **256.95 ms** cold start, **12.21 MiB** idle working set, and the exact six-tool surface. The original <250 ms cold-start target therefore remains a narrow measured miss in this run. See `docs/benchmarks/release-candidate-2026-09-21.md`.

## Security

Do not put credentials, bearer tokens, browser cookies, or device secrets in Git history, command output, fixtures, or logs. See SECURITY.md and docs/security/threat-model.md.

## Contributing

See CONTRIBUTING.md. Tetherplane development uses written plans for multi-step work, strict TDD for implementation, systematic root-cause debugging, and fresh verification before completion claims.

## License

Licensed under either Apache License 2.0 (LICENSE-APACHE) or MIT (LICENSE-MIT), at your option.
