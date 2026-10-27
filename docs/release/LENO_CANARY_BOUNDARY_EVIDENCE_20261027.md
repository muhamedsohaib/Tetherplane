# Leno canary boundary — evidence checkpoint (2026-10-27)

Status: **NO-GO; read-only Leno observations, no repair or installation**.

## Exact software references

- Repo: `muhamedsohaib/Tetherplane`
- Diagnostic draft PR: #70, `feature/leno-readonly-preflight-20261027`
- Latest Store-runtime draft: #69 at `25c5e7f34cc7c2b7cf440d7b30db7e979610deec`. Its GitHub Windows/Ubuntu CI and MSIX G2 jobs passed but **that does not mean the new version is installed on Leno**.
- Leno native agent version/hash: **unverified**. Read-only process signature/hash was `UNAVAILABLE`. No Tetherplane MSIX package registered for the querying user.

## Observed Leno — user-operated read-only PowerShell

Observations are from the user's Leno terminal, not independently corroborated by a privileged remote session.

First snapshot, `2026-10-27T19:55:53.3798832Z`:

| Measure | Observation |
|---|---|
| Windows build | 26300 |
| Tailscale service | Running |
| Native `tetherd.exe` process | PID 20396 |
| Tetherplane Leno Canary task | Running |
| Tetherplane Emergency Relay task | Running |
| Older Tetherplane Agent / Tetherplane Leno Agent | Disabled |
| Active agent executable hash/signature | UNAVAILABLE |
| Tetherplane MSIX in current user scope | None |
| Raw SAC registry status | `VerifiedAndReputablePolicyState=1`; policy indicated enforcement, independently observed block below |
| Code Integrity | `3077` for `tetherd.exe` at `2026-10-27T08:00:45.0996612Z` |

Second snapshot, `2026-10-27T20:30:31.3320182Z`:

| Measure | Observation |
|---|---|
| Tailscale backend / self | Running / online |
| Leno Canary | Running, last run `2026-10-27T08:01:46Z`, result `2147946720` = `0x800710E0` |
| Emergency Relay | Running, last run `2026-10-24T07:42:54Z`, result `267009` = `0x41301` |
| `tetherd.exe` PID 20396 TCP | 1 Bound, 1 Established |
| Actual authenticated connector status | `device.status(Leno)` still returns `disconnected` |

Interpretation: `0x800710E0` wraps Windows `ERROR_REQUEST_REFUSED` (4320; generic 'operator or administrator has refused the request'). It **does not identify** which policy, condition, or scheduler operation refused this launch. `0x41301` is Task Scheduler's normal `SCHED_S_TASK_RUNNING`, not a failure. The Code Integrity 3077 timestamp precedes the recorded canary run by approximately 61 seconds; coincidence in time is not proof of causal linkage. An established TCP socket is not proof of authenticated relay access.

References:
- https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--4000-5999-
- https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-error-and-success-constants

## Failed boundary and smallest next observation

The failure is **above basic tailnet reachability**: the existing plugin cannot authenticate/route a `device.status` request to Leno, despite the local agent process and Tailscale being up. Whether the process is connected to VAULTER, localhost, another tailnet peer, or a non-tailnet socket remains unknown. Whether task scheduler refused an extra launch, or SAC blocked a different executable attempt, remains unknown.

The read-only script `scripts/msix-store/Inspect-Leno-Canary-Boundary-ReadOnly.ps1` records:
- Exact canary last result and safe task settings (no task action arguments).
- Process creation timestamp to determine whether PID 20396 predates the blocked launch.
- Established socket **peer category only**; no destination IPs or URLs.
- Bounded Task Scheduler Operational event IDs/times correlated with canary, and Code Integrity 3077 event IDs/times (no event messages or executable paths).

The script has no policy, task or installation mutation. It was parsed, statically screened and run in disposable GitHub-hosted Windows PowerShell 5.1 CI (#40579436996). **CI is not the Leno observation.**

## Third live Leno observation — connection and startup generation

User-operated snapshot at `2026-10-27T20:39:30.2339058Z` (no changes made):

| Evidence | Exact observation |
|---|---|
| Canary task state / multiple instances | `Running` / `IgnoreNew` |
| Canary user context | `Interactive`, `Highest` |
| Canary previous result | `0x800710E0`; the reason for the refused request remains **unproven** |
| Active `tetherd.exe` PID | `20396` |
| PID creation time | `2026-10-24T10:02:26.7665250Z` |
| Agent established peer | `TAILNET_VAULTER`, one TCP connection |
| TaskScheduler Operational event query | Latest bounded 800 messages / 72h returned **no matching canary events**, which does not establish that no events exist |
| Code Integrity block | Event `3077` for `tetherd.exe` at `2026-10-27T08:00:45.0996612Z` |

**Key timeline**: The existing PID began on **October 24**, nearly three days before the October 27 denied launch. The denial is therefore a separate attempt; it cannot have prevented the October 24 process from starting. With `IgnoreNew`, a refused concurrent attempt is plausible but **not verified as the 0x800710E0 cause**. The agent currently talks to VAULTER at the TCP layer; no conclusion may be drawn from the TCP socket alone about successful authentication.

### Source-specific relay inference

Inspected repo `relay/src/routing/device-router.ts`, `relay/src/devices/ws-gateway.ts`, `agent/tetherd/src/relay_ws.rs` on the current diagnostic branch:

- `DeviceRouter.#resolveConnection` returns `capability_unavailable` if unknown, `permission_denied` if wrong account/revoked, and **`disconnected: requested device is offline`** when the named device is a valid registry binding but **no active WebSocket is in the router's in-memory `#connections` map**.
- `DeviceWebSocketGateway` registers a live device only **after** authenticating its Device Authorization header and accepting the WebSocket upgrade, then calling `router.connectDevice`.
- The Rust client reconnects after retryable transport errors; credential 401/403 is **fatal** for a given process. A connected TCP socket to VAULTER need not be connected to the **same relay instance/path** serving the MCP client, or even represent a completed device WebSocket.

**Narrowest proven failed boundary:** In the connector-facing relay instance, the authenticated Leno device WebSocket is not registered at the time of `device.status(Leno)`. The corresponding old process and network peer are observed but exact executable version/hash, remote TCP port, active relay instance, device-id argument and protocol status remain unknown.

**Do not restart or disable the only old process yet.** It might be the only functioning background process and replacing it may encounter the observed SAC block. Next smallest low-risk observation is a local classification of that process's remote port plus sanitized configured device ID/relay endpoint (not the credential, command line, absolute path or IP). A matched relay instance can then be checked for device-session registration through an already-authorized read-only interface. Do not inspect other users' relay identities or persist session tokens.

## Next classified identity/route comparison

New `scripts/msix-store/Inspect-Leno-Agent-Route-ReadOnly.ps1` is deliberately limited to facts that can distinguish stale or misdirected sessions without exposing secrets:

- `device_id_class`: exact `Leno`, case-only mismatch, another device ID, or unavailable. **Never outputs the actual ID if different**.
- `transport`, `configured_host_class`, and `device_path`: WSS vs WS, VAULTER-named vs other target, and whether the WebSocket URL path is exactly `/device`. It never prints URL/host.
- `configured_port` and `active_remote_ports`: port numbers only, **never IP addresses**.
- `canary_action_kind`: direct `tetherd` vs PowerShell/CMD wrapper/other. It never prints the task arguments or executable paths.
- The script does not read credential files, restart processes, alter ACLs, change Windows policy, or attempt pairing.

**Exact-script CI evidence:** Windows PowerShell 5.1 parse, static no-mutation scan and isolated execution passed in [Leno read-only workflow #40581073108](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40581073108). **This is not a real Leno result**; when the actual owner runs the script, record its JSON below before choosing a corrective action.

### Decision gate for the classification

- If device ID class is not exact `Leno`: classify as **device identity mismatch**; no auto-re-pairing or credential replacement.
- If host/path/port is inconsistent with the live Leno WebSocket relay path: classify as **stale/misdirected canary configuration**; preserve task and old process for a reversible, owner-approved recovery.
- If device ID and endpoint are consistent and TCP is established: relay-side **WebSocket registration / instance / session** is the next boundary; use already-authorized read-only registration diagnostics before changing anything.
- If command line is inaccessible: mark **UNKNOWN**. Never infer an ID mismatch from missing telemetry.

## Fourth user-operated Leno result — configured route not observable

User-provided output at `2026-10-27T20:56:29.1002998Z`:

| Field | Observation |
|---|---|
| Canary action executable | `TETHERD_DIRECT` |
| Agent PID | `20396` |
| Device-ID argument | `NOT_VISIBLE` |
| Relay transport, host class, route path, configured port | `NOT_VISIBLE` |
| Established remote TCP port | **`10000`** |

**Critical distinction:** An invisible process command line is not a wrong device ID or wrong relay URL. The program may lack permission to read the command line of the task's elevated process. A TCP session to VAULTER port 10000 is consistent with earlier successful tailnet-only relay handshake tests; it must **not** be labeled a bad port on its own.

Retested the available authenticated connector tool: `device.status(Leno)` still returns `disconnected: requested device is offline`. `device.status(VAULTER)` succeeds with agent 0.1.0 in background-only mode, indicating the connector itself is not wholly unavailable.

Source review of `relay/src/routing/device-router.ts` and `relay/src/devices/ws-gateway.ts` establishes:
- The connector-facing relay registry recognizes the requested Leno account binding (otherwise it returns unknown device or permission denied), but the currently routed instance lacks a live Leno device connection.
- A TCP connection does not demonstrate a completed authenticated WebSocket upgrade/registration.
- The agent may connect to a different VAULTER relay listener from the connector-facing HTTPS/MCP endpoint, or have a stale/failed device WebSocket while TCP remains ESTABLISHED. **Neither is yet proven.**

**Next minimal discriminator:** Compare a read-only, safely redacted snapshot of **the canary task's configured** device ID/relay path and the **relay instance routing** exposed by the already authorized owner. Since the actual PID's launch arguments are unavailable, do not attribute the task's current action arguments to the old process. Do not fetch or output credentials, task arguments, raw URLs, device authorization headers, registry credential hashes or other user identities. Prefer to verify route alignment by locally computing redacted classifications, not by publishing endpoint details.

**No intervention authorized:** no new process launch, killing/restarting PID 20396, task enablement, ACL modification, Smart App Control disablement, re-pairing, replacement credentials or relay redeployment. Gate remains **NO-GO**.

## Do-not-touch and release gate

Do **not** disable Smart App Control, replace device credentials, restart or re-enable disabled Tetherplane tasks, change relay identity/authentication, modify the user profile ACLs, or install the development-signed MSIX onto this active canary without a separately approved, reversible, signed trial.

Remaining gate: trusted/signed installation and real-world on-device owner-approved pairing, other-user denial, relay acceptance, reconnect, removal/rollback, and independently verified four-device operation. **Release NO-GO.**
