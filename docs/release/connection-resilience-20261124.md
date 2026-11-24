# Relay transport resilience review — 2026-11-24

## Scope and observed failure boundary

Base candidate: 7be6ccc47797d977c06bcff395672dbcee2b6330 (CI 45377377687 passed, integrated isolated staging G1/G2/G3/G5/G7 passed; G4 and physical G6 blocked). Installed device source parity is not established. No live device agent, credentials, relay configuration, policies, installations, or foreground permissions have been changed.

The base agent awaits inbound provider work and browser probing in its socket-maintenance loop. Thus a long-running task can defer reading Pong/Close frames and sending new Ping frames. A missed heartbeat can be a consequence of local workload, not necessarily a network outage. The installed binary is a different, incompletely identified build; these observations are source-backed candidate defects, not proof of the cause of every production outage.

## Review changes

- Keep one ordered invocation worker (including policy sync) independent of socket maintenance, and one independent browser health-probe worker.
- Bound connect handshake to 15 seconds and all socket sends to 5 seconds. Preserve authenticated WSS requirements and fatal HTTP 401/403 handling.
- Retain at most 16 waiting messages / 4 MiB of queued text while work is active. Reject overflow or an invocation waiting at least five seconds before dispatch with an explicit not-dispatched resource conflict. Never silently drop a policy sync and continue on the same overloaded connection.
- Keep already-dispatched work separate from connection generation. When a connection ends, discard its still-queued requests, do not automatically replay them, and do not send the old active result over a new session. An already-dispatched operation may finish; its outcome must be reconciled, not assumed or automatically retried.
- Send cached capability state promptly at hello and update telemetry after independent browser probing.
- Log session attempt duration, connection closure/loss and reconnect delay without printing credentials or request bodies.

These are intentional source-candidate decisions, not a validated production tuning policy. The serial worker protects ordering but an indefinitely stalled provider can still obstruct later work. Relay-side stale-peer detection, durable connection history, per-operation cancellation/reconciliation, replay authorization, browser service supervision, and exact installed-version parity remain separate gates.

## Verification contract

New tests exercise a real slow child process while WebSocket heartbeats continue, reconnect during work without replaying a queued file append or an old response, and bounded queue rejection. Existing authentication-negative, TLS, policy sync, and heartbeat tests must also pass. Integrated Linux staging must be rerun on the exact revision. Local Windows application control blocks rustfmt; do not circumvent that policy. Native compilation/format/lint/test results come from isolated CI, not a claim of local success.

No physical-device trial until a separately verified authorized test target, signed/verified candidate package, rollback evidence, and explicit release/pilot approval exist. Retain the previous green candidate as the source comparison point. No protected merge or deployment authorized.

## Relay-side stale-peer follow-up

The gateway previously registered authenticated connections until a socket error, close event, supersession, or explicit disconnection. It now challenges each authenticated session every 30 seconds (after the prior matching Pong) and allows 60 seconds for the matching response. A missing or mismatched Pong cannot keep the session online. The router's existing generation-bound disconnect path settles pending routes; the heartbeat does not replay operations. Superseded and closed sessions have their timers cleared. The relay emits structured session IDs, elapsed times, last matching-Pong age, bounded reason codes and numeric close codes, not credentials, raw frames or peer-supplied close text. Shutdown terminates only sockets owned by this gateway. Asynchronous authentication cannot register a new socket after shutdown.

These conservative defaults are candidate tuning, not measured production SLOs. A legacy agent that cannot read Pong/Ping frames during unusually long work could still be disconnected, so mixed-version rollout needs explicit compatibility testing. Persistent retention and cross-host log correlation still need verification. Tests use real local authenticated WebSockets, including a nonresponsive peer returning mismatched Pongs and a superseded connection with an outstanding challenge. No live relay or device is modified.

## Browser extension session recovery follow-up

Base candidate 547fd802565517ff64dfed2ce78addf7d7d86d0b passed all three CI jobs, including native tests, Windows package smoke, and integrated isolated staging (run 45385590239). Browser session corrections: bridge-side 10 s authentication and 90 s authenticated application-idle deadlines (existing extension keepalive every 20 s); client-side 12 s connection/authentication deadline; closed-session message buffers discarded, pending waiters settled, late events from previous sockets ignored, and unauthenticated sockets retired at shutdown. Reconnection uses the existing pinned identity and token. No human tab reload, permission restoration, automatic mutation replay, or production agent/relay change. Local isolated verification: 32/32 focused session, backend and RPC tests, both browser TypeScript checks, extension build and 53/53 extension tests (8 session tests overlap the focused suite), git diff --check. Full exact-revision CI remains required. Limits are provisional. Application keepalives establish session activity, not individual command progress or CDP readiness; an in-flight browser action may have executed before loss, and must be reconciled. Legacy installed builds and the managed CDP path remain separately unverified. No claim of four-device acceptance or production deployment.
