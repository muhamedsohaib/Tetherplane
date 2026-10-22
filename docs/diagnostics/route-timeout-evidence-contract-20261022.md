# Route-timeout evidence contract — 22 October 2026 (review only)

## Observed, not inferred

The Work-mode investigation reported authenticated `device.status` timeouts for Leno at 12:44 and 12:55:54 Dubai time, and for the single explicitly authorized Surface comparison at 12:47. The later Leno Git/build inspection also timed out. Existing VAULTER Workspace reports remained readable. This is **not a Leno-only incident**.

The draft's reviewed `relay/src/routing/device-router.ts` creates a pending route and starts its deadline timer **before** awaiting `connection.send(message)`. If the pending entry survives until that deadline, the returned error is `timeout`. In that path, a timeout does **not** prove:
- WebSocket send completion or agent receipt;
- successful authorization/execution on the agent;
- return-transport delivery;
- response acceptance or rejection at the relay.

`relay/src/devices/ws-gateway.ts` calls `socket.send` and parses incoming result messages, but the reviewed implementation does not emit correlated boundary events across these stages. Router-generation regression tests are synthetic, not live TLS/recovery reproduction.

The owner-created read-only VAULTER reports place `tailscaled` PID 7624 on port 10000 (two listener entries) and `node` PID 7072 on port 8788. They do not identify the **deployed relay application build** or establish request delivery.

## Minimum evidence to collect — no protected changes

1. **Deployed identity**: UTC timestamp, host label, running process PID/start time, executable basename + SHA-256, and if independently recoverable the *non-secret* application entrypoint basename + SHA-256 and a verified build/commit identifier. A `node.exe` SHA identifies Node, **not** the relay bundle; mark the relay build `unverified` if only Node is hashed. Avoid printing raw process command lines, credential paths, task arguments, environment variables, and full filesystem paths.
2. **Existing local audit**: if the agent's configured, authorized audit feature is enabled, summarize only timestamps, device label, capability, event status and a one-way correlation ID where available. An audit absence is not evidence of nonexecution unless the audit is proven enabled and complete for that device/time window. Never copy raw request arguments, output, token material, or private audit actor identities.
3. **Relay boundary**: for one authorized request, correlate the same redacted request/route ID and UTC timestamp at `route_created`, `send_started`, `send_completed` or `send_failed`, `socket_result_received`, `result_accepted` or a categorized `result_rejected`, `route_timed_out`, `connection_closed`.
4. **Agent boundary**: correlate `invoke_received`, `policy_decision` (category only), `execution_completed` (status only), and `result_write_completed` or `result_write_failed`. Report omissions as `not_instrumented`, not as negative observations.
5. **Sanitization**: emit only UTC ISO timestamps, stage enum, success/error category, device label, redacted stable correlation hash, generation hash, and elapsed milliseconds. No addresses, authorization headers, credentials, OAuth/DCR artifacts, raw invocation/result payloads, message text, environment contents, or unfiltered logs.

## Decision table

| Observed boundary | What it proves | What it cannot prove |
| --- | --- | --- |
| `route_created` only | A registered relay connection was selected | Data reached a socket or agent |
| `send_completed` | WebSocket library send callback completed | Remote agent received/executed it |
| `invoke_received` | Agent dispatcher saw that invocation | Authorization or execution succeeded |
| `execution_completed` | Agent produced an operation outcome | Outcome returned to the relay |
| `socket_result_received` | Relay received a candidate result | Route ID, generation or request ID matched |
| `result_accepted` | Matched pending request resolved | Later client/UI delivery |
| `route_timed_out` without earlier markers | Deadline expired | Which of the above steps failed |

## Operator workflow and hard stop

- **Now**: use only local authorized, read-only collection of existing process metadata and already-enabled audit summaries. The owner's approved Tetherplane Workspace is the file-only transfer path for *sanitized* output. Do not broaden VAULTER's principal or copy private files to an unapproved location.
- **If any requested event is unavailable**: mark `not_instrumented` and do not guess the missing boundary. Prepare an opt-in instrumentation patch with focused synthetic tests, security review, and default-off behavior on a separate draft branch.
- **Before a live instrumented deployment or induced connectivity fault**: require explicit approval, signed-artifact validation, rollback and a maintenance window. Never use another authorized machine/SSH to circumvent a Tetherplane `permission_denied`.
- Do not restart or reconfigure production relay/TetherAuth/Tailscale, alter identities or OAuth clients, contact RTX while excluded, merge, tag or release based solely on this report.

## Release gate

Existing Windows/Ubuntu CI on PR #43 at `1df3b3862bac5b76db0b5d4b2bdb155e83f24773` passed, but Vercel reported a separate failure. No correlated live route events, deployed application build identity, controlled reconnect/recovery, signed clean-install acceptance or independent sign-off yet. **NO-GO**.
