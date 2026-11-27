# Upgrade Sequence: S1 Agents Before S2 Relay Enforcement

Normative for the Architecture B heartbeat rollout. A relay running S2
stale retirement retires any device socket that stops echoing nonce
Pongs — including pre-S1 agents whose Ping reply is blocked inline
behind a long invoke. There is no version negotiation on the device
channel, so the relay cannot distinguish a healthy legacy agent doing
long work from a dead socket. I verified by inspection that no
backward-compatible rollout mechanism exists: `ws-gateway.ts` has no
agent-version detection and no heartbeat kill-switch, and `relay_ws.rs`
sends no version in the device handshake.

## Required order

1. Build agents from a revision containing the S1 commit
   (`feat(agent): S1 heartbeat independent of ordered work queue`).
2. Install S1 agents on every device in the fleet and confirm each one
   reconnects (new connections are new generations; nothing replays).
3. Only then activate a relay containing the S2 commit
   (`feat(relay): S2 nonce heartbeat and stale-socket retirement`).
4. Monitor the retire rate for 24 h (see below) before declaring the
   rollout complete.

## Why this order is required

- Post-S1 agents answer relay Ping frames at the socket level from an
  independent select loop, so long invokes never block Pongs. The S6
  stability oracle proves a real agent surviving an 8 s provider
  operation plus sustained heartbeats with no retire.
- Pre-S1 agents answer Ping inline in the sequential work loop. Under
  S2 enforcement, a legacy agent mid-long-invoke goes silent past the
  45 s stale deadline and is retired (its in-flight work settles
  `disconnected`; the agent reconnects and reconciles). This is the
  S2 escalation condition, reported rather than loosened: retiring
  the socket is correct, but the legacy agent experiences it as a
  disruption of healthy work.
- Reversing the order (S2 relay first) therefore disrupts every legacy
  agent that runs an operation longer than ~45 s. There is no flag to
  exempt them.

## Fleet-readiness verification

Because the relay observes only Pong behavior (not versions), readiness
is verified out of band:

1. Confirm by deployment records that every device runs an agent build
   at or after the S1 commit.
2. Canary the S2 relay against a subset of devices first.
3. Watch the retire path during canary: unexpected `disconnected`
   settlements on healthy long operations indicate version skew —
   halt the rollout and finish the agent upgrade before proceeding.

## Rollback

- Relay rollback: redeploy the pre-S2 relay. Agents (S1 or legacy)
  reconnect as new generations; S1 agents keep their own 20 s
  dead-man detection regardless of relay behavior.
- Agent rollback below S1 while an S2 relay is active reintroduces
  legacy long-work retirement; do not do this outside an emergency,
  and re-upgrade immediately.
