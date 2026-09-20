# Tetherplane Threat Model

This document maps the v1 security claims to the implemented local authority boundaries and executable evidence. It does not claim protection from malware already running with equal or greater operating-system privilege than Tetherplane.

## Authority model

The local `tetherd` process is the final authority for device execution. Transport identity, MCP client identity, model output, file contents, page contents, caller arguments, and relay metadata are inputs to the local authority boundary; none of them can replace the launch-bound local principal or local policy.

## Threats and evidence

| Threat | Enforcement boundary | Executable evidence |
| --- | --- | --- |
| Prompt-injection-shaped file/page content attempts to grant authority | Canonical invocation fields and launch-bound principal are separate from observed content | `tests/e2e/hardening-security.test.ts`; `tests/e2e/model-client.test.ts` |
| Parent traversal, symlink/junction escape, or mixed separator escape | Local filesystem policy canonicalizes and constrains allowed roots | `agent/tether-core/tests/policy.rs`; `tests/e2e/local-compact.test.ts` |
| Caller forges approval or human identity inside tool arguments | Policy derives authority from authenticated execution context, not arbitrary argument fields | `tests/e2e/hardening-security.test.ts`; `agent/tether-core/tests/policy.rs` |
| Caller/model forges principal identity | `AgentRuntime` replaces caller principal claims with launch-bound local principal | `agent/tetherd/tests/stdio_rpc.rs`; `tests/e2e/local-compact.test.ts`; `tests/e2e/model-client.test.ts` |
| Secret-bearing arguments become durable audit data | Audit records canonical lineage and result metadata without persisting invocation arguments | `agent/tetherd/tests/audit.rs`; `tests/e2e/local-compact.test.ts` |
| Browser diagnostics leak authorization/cookies/tokens | Browser diagnostics redact credential-shaped headers and values before transport | `browser/bridge/test` diagnostics/redaction tests |
| Retry/replay duplicates a mutation | Local idempotency store binds key to canonical mutation and survives restart | `agent/tetherd/tests/idempotency.rs`; `tests/e2e/browser-recovery.test.ts`; `tests/e2e/remote-plane.test.ts` |
| Relay routes across accounts/devices or replays after reconnect | Account-scoped device router, connection generations, request correlation, no automatic replay | `relay/test`; `tests/e2e/remote-plane.test.ts` |
| Human-owned browser/desktop resource is mutated in background mode | Trusted ownership registry and browser ownership store deny unknown/human mutation | `tests/e2e/browser-coexistence.test.ts`; `tests/e2e/desktop-coexistence.test.ts` |
| AI self-mints foreground authority | Only local Human actor may create a ForegroundLease; physical executor requires matching live scope | `agent/providers/desktop/tests/foreground_lease.rs`; `tests/e2e/desktop-coexistence.test.ts` |
| Recent human activity collides with physical fallback | Local last-input monitor blocks physical action during quiet interval | `agent/providers/desktop/tests/human_activity.rs`; foreground lease tests |
| Stale semantic target is rebound to unrelated resource | Semantic identity reacquisition must match or fail `stale_reference` | browser recovery tests; desktop UIA reacquisition exercised by `tests/e2e/desktop-coexistence.test.ts` |
| Stale process handle after agent restart binds to a new process | Process handles are opaque, runtime-scoped registry entries | `tests/e2e/hardening-recovery.test.ts` |

## Transport and hosted relay visibility

The hosted/self-hosted relay terminates MCP HTTP and therefore can observe request/result payloads in transit. Tetherplane does not claim generic end-to-end secrecy through a hosted relay. Durable relay state is limited to bounded pairing/device metadata; tool payload persistence is not implemented. See `docs/security/remote-plane.md`.

## Out of scope

Tetherplane v1 does not claim to defeat:
- malware with the same or greater OS privilege as the local agent;
- a compromised operating-system kernel;
- arbitrary third-party application behavior after an authorized action;
- physical sleep/wake certification on every hardware/firmware combination.

The design instead aims to fail closed at Tetherplane-owned authority boundaries and to make recovery/idempotency behavior explicit.
