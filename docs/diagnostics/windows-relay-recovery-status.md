# Windows relay recovery diagnostics (review-only)

This operator-invoked PowerShell script is a **read-only status snapshot**, not a reconnect command and not a daemon.

```powershell
powershell.exe -NoProfile -NonInteractive -File .\scripts\diagnostics\windows-relay-recovery-status.ps1
```

It reports UTC observation time, hostname, agent task state/last task result, agent count/PIDs, established TCP connection count and remote **ports only**, and counts of recognized error classes in the last 100 lines of the existing Leno task stderr log. It does not print relay addresses, process command lines, URLs, log lines, device credentials, tokens, or task arguments.

## Meaning and limitations

- `agent_task_state=Running` proves only Windows Task Scheduler's task state.
- `established_tcp_count>0` proves only a TCP connection; it does **not** prove TLS negotiation or a live authenticated relay registration.
- `tls_handshake_eof_count` is a historical count across the selected tail, not a current failure rate or a reason to restart.
- `log_last_write_utc` can be compared with `observed_utc`; old log data may coexist with healthy connections.
- The only end-to-end live check is a separately authenticated `device.status` request through the actual MCP client, followed by a negative authorization test.
- A stable missing or unchanged log does not establish cause, service-level reliability, or successful recovery.
- Do not point `-LogPath` to sensitive files and do not publish raw credential-bearing logs.
- This diagnostic does not modify Scheduled Tasks, registry, process state, OAuth/DCR clients, identity config, device pairing, or the protected four-device architecture.

## Observed Leno incident, 22 October 2026

Before recovery, authenticated ChatGPT calls returned `disconnected`; local `tetherd.exe` PID 7660 remained alive with an established TCP session to remote port 10000. stderr reported repeated `tls handshake eof` and an OS 10054 remote reset. Subsequent native ChatGPT `device.status(Leno)` and `device.capabilities(Leno)` succeeded without restarting PID 7660.

At 2026-10-22T06:09:35Z the exact source-controlled script logic was exercised as an ephemeral PowerShell command on Leno; it exited 0. Result: one agent (PID 7660), task Running, one TCP session (remote port 10000), last log write 2026-10-22T05:33:03Z, last 100 lines 99 EOF and one 10054. This is **real-device read-only diagnostic validation**, not an induced fault/recovery test.

## Remaining acceptance gates

Correlate local agent, relay TLS termination, authorized WebSocket registration and MCP router connection generation before claiming root cause. Run synthetic EOF/reset regression tests in CI first. A separately approved test-device fault injection must measure reconnect time, retained principal/identity, no replay of in-flight mutations, denial of unauthorized operations, and rollback. No public release or merge until reviewed.