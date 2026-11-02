# Physical-device-inspired WebSocket regression — 2026-11-02

**Base:** Draft PR #123 (`4240ba8b3e638770082a0c62814924b45c99aa76`).
**Scope:** Test-only; no runtime logic, Windows deployment, signing, credentials, service configuration, or Tailscale changes.

## Failure being modeled

After an upstream Funnel or Tailscale session changes, a Windows device may still show a TCP socket as `Established` while authenticated MCP `device.status` says the agent is offline. This was observed on Surface and Leno on 2026-11-01 and 2026-11-02. Manually restarting the existing agents temporarily restored connectivity.

## New regression

`real_websocket_peer_without_pong_expires_even_while_tcp_remains_open` opens a real 127.0.0.1 WebSocket server and client. The server completes a valid WebSocket upgrade, then intentionally stops polling its socket while continuing to hold that socket open. The client must issue a Ping and return a **retryable** missing-Pong error before the bounded test deadline. The test never touches a live relay, browser, credential or external network.

The existing tests already cover a healthy matching Pong, unrelated messages that cannot hide a missing Pong, saturated work slots, preserved control capacity and non-cancellation of mutating operations. This new test adds a real transport boundary to the synthetic heartbeat checks.

## Evidence and release limit

- The base implementation has green exact-head Ubuntu/Windows CI on PR #123, including Rust tests and Windows release-binary build.
- This new test requires its own exact-head Rust formatting, Clippy and Windows/Ubuntu tests before being accepted.
- A CI pass still does not prove unattended reconnection on a real Windows machine after sleep/wake or WAN churn. The patched binary remains uninstalled and must not replace a production agent without an approved private canary and rollback.
- Tailscale Funnel coordination registration is an independent upstream issue, tracked at `tailscale/tailscale#21114`; no vendor opt-in or network restart is part of this test.
