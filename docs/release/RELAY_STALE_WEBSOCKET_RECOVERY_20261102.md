# Tetherplane stale-WebSocket recovery candidate — 2026-11-02

Base: draft PR #122, `4b1e530779e37e50756242d11a609d4a19a4971f`.
Isolated branch: `fix/relay-stale-websocket-recovery-20261102`.
Disposition: **REVIEW ONLY. NOT INSTALLED OR RELEASED.**

## Observed failure

On 2026-11-01, Vaulter Funnel public TLS failed after an upstream WAN address change while direct private Tailscale remained healthy. Leno and Surface then held `Established` TCP sockets while authenticated MCP `device.status` returned `disconnected`. A single owner-authorized task restart per agent restored the real MCP path.

At 2026-11-02 10:14 UAE, all three Vaulter Funnel IPv4 probes returned HTTPS 200 from both Vaulter and Surface. Leno was authenticated through MCP. Surface was again reported disconnected despite an older established private TCP socket. This is evidence of an agent-side stale socket, not proof of a new public Funnel outage.

## Narrow proposed change

`agent/tetherd/src/relay_ws.rs` adds a 20-second outbound WebSocket handshake deadline, an idle Ping after 25 seconds without inbound frames, and a 15-second deadline for the **matching** Pong. Unrelated frames and unsolicited Pong cannot satisfy the challenge. Existing 2-second write deadlines and the reconnect loop remain. HTTP 401/403 authentication denial remains fatal. Shared work/control budgets and detached, non-replayed mutations are unchanged.

Regression tests cover half-open sockets, successful matching Pong, and unrelated traffic with missing Pong. These are unit tests; production WAN loss acceptance remains outstanding.

## Evidence and limitations

- Leno: `cargo fmt --all -- --check` and `git diff --check` passed.
- Leno: the **existing installed** Rust agent passed a real isolated Edge/CDP/MCP Browser Lab integration test (create, snapshot, verified action, origin denial, grant revocation); the test is opt-in and uses a temporary localhost origin, never real sites or personal browser profiles.
- Leno: Rust compilation **blocked** by absent Microsoft MSVC linker and Windows SDK. No new Rust binary was produced. Exact-head Windows/Ubuntu CI must compile and test the new heartbeat code before any canary rollout.
- The agent patch does not fix WAN churn or Tailscale Funnel ingress reliability. Tailscale/relay health requires separate monitoring.

## Release gate

1. Exact-head CI (Rust tests, clippy, format, Windows/Ubuntu), no Vercel previews.
2. Synthetic and real-WebSocket healthy-idle, WAN loss, missing Pong and reconnect tests.
3. Confirm independent `device.status` responsiveness, non-replayed side effects, saturation, rollback, reboot and sleep/wake on physical Surface and Leno.
4. Do not modify production device identity, OAuth/DCR clients, Windows security, scheduled tasks, Tailscale Serve/Funnel config or protected Git branches without separate approval.

This branch contains only reversible review-source changes.
