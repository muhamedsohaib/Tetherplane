# Security Invariants

These hold during normal operation *and* recovery. Any change violating one is rejected, not traded for availability.

1. **Local authority is final.** The launch-bound principal in `tetherd` decides; transport, model output, file/page content, dashboard, and relay cannot replace it. Relay principal overwrite is routing metadata only — the device rebinds.
2. **Recovery never broadens access.** Reconnect, restart, policy sync, and lease/job resume can only restore the previously effective grant, never exceed it. Grants narrow, never widen (canonicalized paths reject parent-dir/symlink escape).
3. **No credential exposure.** Device/client credentials are stored hash-only (`SHA-256`, constant-time compare); TLS/WSS required off-loopback; audit and evidence never persist raw arguments, keys, tokens, or secrets.
4. **No unsafe replay.** Uncertain mutations are never replayed automatically; stale generations, routes, handles, and semantic references fail closed (`disconnected`, `invalid_arguments`, `stale_reference`, `action_unverified`).
5. **Human coexistence is not bypassable.** Default `background_only`; human tabs/processes/windows are not mutated without explicit scoped local grant (ownership registry, foreground lease ≤120s, human-idle check). Recovery does not mint leases.
6. **Degradation is never concealed.** Provider failure, partial health, and unknown outcomes surface as `degraded`/`disconnected`/error — never as success, never as generic "online".
7. **Fencing.** Every operation and result is bound to (principal, device, generation, routeId, request_id); cross-account/principal/device access is `permission_denied` before provider dispatch (denied calls never reach providers — covered by `principal_policy` tests).

## Provider-neutral evidence (future VouchOut interface)

Separate `ExecutionEvidence` emitted by `tetherd` *after* policy decision, alongside (not inside) `ResultEnvelope`. Adapters/relay only forward; they cannot mint principal or generation.

Fields: execution `{request_id, capability, provider, launch-bound principal_id, actor (provenance only), device_id, job_id?, session_id?}`; target `{kind, opaque handle or semantic-ref hash, ownership, lease_id?}`; connection `{generation, route_id, transport, reconnect_of}`; correlation `{idempotency_key_hash, fingerprint, batch_parent?, checkpoint_id?}`; outcome `{status, verification, error_code, policy_decision, duration_ms, replayed, degraded+reason}`; integrity `{evidence_hash, prev_audit_event_id?}`.

No dependency on VouchOut is introduced; integration needs separate owner approval.

## Escalation

A request to bypass authentication, widen a grant during recovery, disable OS protections, or replay an ambiguous mutation is refused and escalated to the owner. See [SPARK_EXECUTION_PLAN.md](/workspaces/Tetherplane/docs/SPARK_EXECUTION_PLAN.md).

## Closure refinement

Synchronization ceiling: any future Desired-state sync (S4) may only narrow or restore permissions within the launch-bound ceiling set by the on-device `PrincipalProfile` at `tetherd` launch. Exceeding that ceiling requires a local relaunch; the relay, dashboard, and any sync channel can never expand effective authority beyond it. See [ARCHITECTURE_CLOSURE_GATE.md](/workspaces/Tetherplane/docs/ARCHITECTURE_CLOSURE_GATE.md) Gate 2.
