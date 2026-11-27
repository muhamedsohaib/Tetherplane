# Recovery Protocol

## On disconnect

1. Relay settles every pending route as `disconnected`. Nothing is queued for replay.
2. Agent drops the per-generation queue; undispatched work is discarded; a result computed on the old generation is never sent on the new socket.
3. Browser/CDP buffered commands never execute on a new generation; an in-flight mutation whose reply is lost ends as `action_unverified` (wire code; prose "outcome unknown" means this same state — do not introduce a second code).

## On reconnect

New generation, new hello, fresh capability push, then new routes only. State that survives: durable jobs/checkpoints, completed idempotency records, audit, pairing. State that must not survive: process/search handles (unknown → `invalid_arguments`), foreground leases, semantic element/tab references (reacquire or `stale_reference`), MCP sessions.

## Idempotency

- State-changing calls require an idempotency key. Store key: `SHA256(principal, device, capability, key)` + payload fingerprint.
- Same key + same fingerprint after completion → stored result replayed (new `request_id`, `replayed:true` in evidence).
- Same key + different fingerprint → `resource_conflict`.
- Key reserved but outcome unknown (crash after side effect, before the Completed record is durable) → `action_unverified`, an explicit uncertain-outcome state: at-most-once execution is guaranteed, exactly-once visible effect only once Completed is durable; never auto-retry (see closure Gate 3); owner-visible reconcile only. **Never auto-retry an ambiguous mutation.**
- Handles gain a TTL; create-on-retry must not leak duplicates.

## Permission consistency: Desired / Effective / Acknowledged

- **Desired**: versioned intent at relay/dashboard per (account, device, principal): `{version (monotonic), hash, capabilities, devices, directories}`.
- **Effective**: the profile actually loaded by `tetherd` and enforced by `LocalPolicyBroker`.
- **Acknowledged**: device-signed `{device_id, generation, applied_version, hash, result}` on a dedicated policy channel (never piggybacked on invoke/result).
- Rules: device applies only `version > current`; acks are idempotent; lower/stale versions are rejected so delayed or out-of-order acks cannot regress Effective; in-flight invokes pin (policy version, generation); relay displays `pending` while Desired ≠ Acknowledged and never advertises unacked state. Recovery never widens a grant: applying Desired can only set exactly what the owner versioned, and local denial always wins.

Until this ships, dashboard edits are intent only: effective changes require updating the on-device profile, restarting `tetherd`, and verifying via `device.capabilities` + a real `browser` `pages` call.

## Relay permanently unavailable

Remote calls fail `disconnected` truthfully; no queue, no store-and-forward, no local fallback inside the relay-mode process. Local stdio mode remains available only as a separately launched process. The device keeps retrying with backoff and loses no durable state.

## Autonomous vs owner-authorized recovery

Autonomous: reconnect, generation bump, capability re-probe, supervisor restart, idempotent replay of *completed* results, dropping stale handles.
Owner-authorized only: reconciling an `action_unverified` mutation, re-granting/revoking capabilities, re-pairing, clearing a `Pending` idempotency record, any foreground lease.
