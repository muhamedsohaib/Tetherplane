# Durable process invocation receipts (draft)

This describes the source-level supervisor on the draft branch stacked above PR #140. It is **not yet a production release guarantee**.

## Objective

When an authenticated relay WebSocket disconnects after a permitted `process.run` has started, losing the remote caller must not silently cancel the work, lose the eventual invocation receipt, or cause the same idempotency key to execute twice.

## Opt-in invocation

Only `process.run` calls with a non-empty top-level `idempotency_key` are supervised independently of the WebSocket receive loop.

```json
{
  "name": "process",
  "arguments": {
    "op": "run",
    "device": "my-paired-device",
    "idempotency_key": "owner-defined-unique-operation-id",
    "args": { "program": "my-approved-command", "args": [], "wait_ms": 5000 }
  }
}
```

The agent must be started with a **persistent, access-controlled** `--state-dir`. The operation uses the existing local principal policy, process provider, audit trail and idempotency reservations. Pairing, permissions, and explicit approvals are **not** bypassed.

## Read-only reconciliation

The caller must be authorized for `operation.get` in the local principal profile and must request the same device using the same idempotency key. The compact MCP tool remains `process` (there is no additional top-level tool).

```json
{
  "name": "process",
  "arguments": {
    "op": "operation_get",
    "device": "my-paired-device",
    "args": { "idempotency_key": "owner-defined-unique-operation-id" }
  }
}
```

The receipt is scoped to the bound principal and routed device, and always inspects the `process.run` namespace. Cross-account routing and local capability denial still apply.

| `state` | Meaning | Safe action |
|---|---|---|
| `not_found` | No durable reservation exists in the inspected scope | Verify the original request and its delivery before considering a new attempt |
| `unverified_or_in_flight` | A reservation exists; execution may be active or might have been interrupted by a crash | **Do not automatically retry**. Inspect process effects and reconcile |
| `invocation_completed` | A response from the original `process.run` invocation was durably recorded | Read the stored result; retry with the identical key only to replay the receipt |

A successful `process.run` invocation with `running: true` is a **launch receipt**, not proof of child-process termination. Query the process handle using `process.read` while the same agent session retains it. After an agent restart, process-session handles may no longer be valid; this feature cannot infer a definitive external exit state.

## Failure boundaries

- **WebSocket disconnect:** an already-started, idempotent `process.run` task continues in the agent runtime; upon completion the existing idempotency journal stores its result. The remote MCP request may return `disconnected` because that connection is gone.
- **Duplicate requests:** the pre-existing serialized idempotency lock permits only one side effect; simultaneous identical requests receive the resulting stored response. The read-only receipt inspector does not acquire that execution lock.
- **Agent crash / machine power loss:** unfinished reservations remain `unverified_or_in_flight`, not `completed`. The process could have terminated, could still be running, or could have completed a side effect without a terminal journal entry. Human/owner reconciliation remains necessary.
- **Transport restart after completed operation:** the completed receipt survives the agent restart while `--state-dir` is retained.
- **Network outage exceeding 30 seconds:** status availability cannot be guaranteed while the relay or device remains unreachable.

## Explicit non-guarantees

This is **not** exactly-once execution across arbitrary crashes, power loss, external system side effects, or OS process reparenting. It does not add a service manager, durable child PID+creation-time tracking, OS reattachment, process-tree ownership after reboot, or terminal-exit journaling. Any future automation that reconciles those states must have a separate owner-supervised, permission-checked acceptance gate.

## CI acceptance

The draft tests cover a real child-process side effect, forced relay disconnection, read-only inspection on reconnection, cross-account denial, non-duplicated replay, and the completed receipt after an agent-process restart, on Linux and Windows. Review the exact commit's GitHub Actions evidence before relying on these tests.
