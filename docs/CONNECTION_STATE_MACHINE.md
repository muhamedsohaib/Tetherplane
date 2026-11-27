# Connection State Machine

Normative target for architecture B. Timers are upper bounds, not averages.

## Device connection states

```
Disconnected → Connecting → Connected(G) → Suspect → Reconnecting → Connected(G+1)
     ↑              │             │ 401/403      │ missed Pong
     └──────────────┴─────────────┴──────────────┘
Superseded (close 4000) / Revoked (4001) → Disconnected (terminal for that socket)
Fatal auth (401/403) → terminal, no retry loop
```

| Transition | Trigger | Bound |
|---|---|---|
| Connecting → Connected | WS upgrade + hello accepted, generation `G` issued | connect ≤15s |
| Connected → Suspect | one missed/unechoed heartbeat Pong | suspect ≤15s |
| Suspect → Reconnecting | Pong deadline expires | dead ≤20s + reconnect delay |
| Reconnecting → Connected(G+1) | new socket, new generation, capability push fresh | restore ≤30s after infra returns |
| Any → Disconnected | relay retire (stale nonce, ≤60s), supersede, revoke, partition | pending settles `disconnected` |

Invariants: heartbeat runs on an independent task selected against the ordered work queue (bounded 16 / 4 MiB / 5s wait); a long invoke can never block liveness. Every result is fenced by (generation, routeId, request_id); stale-generation results are dropped, never double-resolved.

## Per-capability states (replaces boolean `available`)

`unknown → recovering (probing) → ready | degraded | disconnected | unauthorized`

- `ready`: last live probe of the actual provider operation succeeded within the freshness window.
- `degraded`: provider up, sub-capability down (e.g. UIA up / physical executor down; CDP up / checkpoint unavailable; extension paired / tab unshared). Degraded is reported as degraded — never rounded up to ready.
- `disconnected`: provider unreachable (bridge/UIA worker dead). Reported even while the device socket is Connected.
- `unauthorized`: provider reachable but policy denies the capability for the effective principal.
- Each push carries `{capability, state, generation, observed_at, reason?}`. Relay marks state stale → `disconnected` after one missed push interval (~30s). `device.status` (process) and capability readiness are separate signals.

## Session states

MCP session: `unbound → bound(identity)`; identity never replaced after bind (mismatch → 403). Relay restart drops sessions; clients re-initialize — sessions are never resurrected with new authority.

## What "ready" requires

A capability may be advertised `ready` only after a post-connect probe of that capability succeeds on the current generation. Accepted execution is not completion; `ResultEnvelope.verification` stays authoritative for outcomes.
