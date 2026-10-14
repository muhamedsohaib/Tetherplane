# Tetherplane Windows Tray Presence Indicator — Design

**Date:** 2026-10-14
**Status:** Proposed written specification for review; the four-device status-only MVP was approved in chat.
**Branch:** feature/windows-tray-presence-design-20261014

## 1. Purpose and acceptance intent

Provide the lightest practical Windows notification-area indicator for the authenticated Tetherplane mesh. Each signed-in Windows user sees **one native tray icon**; opening its menu shows the actual connection state of the paired devices. Initial acceptance targets **Leno, VAULTER, RTX, and Surface**.

The user wants a passive, instantly understandable indication of connected, disconnected, or problematic devices, not a control dashboard. Windows decides whether the icon appears directly on the taskbar or in the hidden-icons overflow; Tetherplane must not forcibly rearrange the taskbar.

Recent field verification established an agent process and TCP connection to the Vaulter relay on all four machines. **Those observations do not by themselves establish an authenticated WebSocket or working remote RPC.** The tray must use server-verified session state rather than infer success from a running process, Tailscale ping, or TCP status.

## 2. Canonical constraints

Follow these sources:

- docs/superpowers/specs/2026-09-17-tetherplane-design.md
- docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md
- docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md

Preserve the Capability Kernel / Providers / Adapters / Transport / Policy Broker separation, local agent final authority, and the six default model-visible MCP tools (device, files, process, browser, desktop, batch). The indicator is a passive observer. It must not initiate device control, request foreground access, affect human-owned windows, repair tasks, change active browser tabs, or carry secrets.

## 3. Selected approach

A **separate native Rust/Win32 tray executable**, not Electron, a WebView, WinForms, or a browser extension. A separate user-session process is necessary because the agent and relay should remain functional without a signed-in desktop session.

Reuse the agent's **existing authenticated outbound WebSocket**. The relay already knows live authenticated sessions through DeviceRouter.isOnline() and the WebSocket gateway. It currently has no appropriate account-scoped presence feed for the tray; GET /devices lists pairings, not current online state.

Data flow:

1. DeviceRegistry plus authenticated DeviceRouter/WebSocket sessions supply the account-scoped roster and live presence.
2. Relay sends a compact **full presence snapshot** over each compatible agent's existing authenticated WebSocket on connect, on a roster or presence change, and at a low frequency for freshness.
3. The Rust agent stores the latest validated snapshot in memory and publishes it through a **read-only local Windows named pipe**. The agent remains the sole network client.
4. The native tray process subscribes to that local pipe, caches the latest complete snapshot, and updates one notification-area icon and a four-row menu.

Full snapshots avoid delta merge logic, missed-change recovery, and extra network connections. For four devices, a snapshot is trivially small. No new public HTTP route, OAuth client, additional cloud credential, or extra model-facing tool is required.

## 4. Presence contract and accuracy

Use one versioned control message type, distinct from routed invocations. Conceptual fields:

- type = presence.snapshot; version = 1
- generation and monotonically increasing sequence number (per authenticated WebSocket session)
- observed_at (UTC timestamp)
- devices = array of { device_id, status }, status being online or offline

The relay selects non-revoked devices **only from the authenticated socket's account**; no cross-account device names, secrets, credential hashes, principals, or remote-control commands appear in snapshots. Registry IDs are preserved exactly (in particular, VAULTER and Surface); the UI may apply simple presentation capitalization.

**Online** means a paired, non-revoked device has a current authenticated WebSocket session in the relay's routing table and has not failed liveness checks. **Offline** means the relay is healthy and confirms there is no such current session. **Unknown** means the local tray cannot establish freshness or reach the local agent's presence stream. Network probes and stale local files must never be interpreted as online.

The relay publishes a fresh snapshot on subscriptions and relevant changes, with a low-frequency refresh at most once every 60 seconds for a steady roster. Live socket liveness must be bounded: implement or reuse protocol-compliant Ping/Pong and mark missed-heartbeat sessions disconnected within 90 seconds. Do not depend indefinitely on a stale TCP connection.

Sequence/generation guards discard out-of-order or superseded snapshots. On relay WebSocket loss or agent reconnect, the agent immediately marks its local presence source unavailable, causing the tray to show unknown rather than the last green state. Snapshots older than 90 seconds become unknown. When the relay returns, a new authoritative snapshot restores actual status.

**Backward compatibility is mandatory:** existing deployed agents only understand invoke messages and would treat an unsolicited presence message as an invalid invocation. The new agent explicitly advertises presence-v1 support during its existing authenticated WebSocket upgrade (an optional capability header or equivalent minimal negotiation); the relay sends presence snapshots **only to opted-in connections**. Old agents continue to receive only invocations.

Presence delivery failures must not interrupt existing invoke/result routing or device policy enforcement.

## 5. Local transport and Windows tray

The agent exposes a one-way, local-only, **versioned named-pipe** stream to the tray. On local subscriber attachment it sends the current snapshot or an explicit unavailable state, then sends replacement snapshots on changes. Use a bounded frame size and reject malformed or oversized input; the tray cannot send device operations or other commands into the agent.

The named pipe must have a tested Windows security descriptor that admits only the intended local user/service identities, with no Everyone or network access. It must not expose device credentials or OAuth tokens. The tray must not require administrator elevation. If the agent runs under a different service identity and a secure ACL has not been configured, show unknown and report a local diagnostic rather than weakening permissions.

The tray uses the Windows Shell_NotifyIcon API, a hidden message-only/native window and a normal Windows popup menu:

- One icon: **green** if every displayed device is confirmed online and the feed is fresh; **red** if the healthy relay confirms one or more devices offline; **amber** when the feed is approaching its freshness deadline; **gray** if status is unknown or the relay/agent is unavailable.
- Menu: the four device names with plain Connected / Disconnected / Unknown indicators, plus a compact connected count. More paired devices may use the same dynamic roster; do not encode a four-device limit in the protocol.
- Tooltip: brief summary, not logs or detailed machine information.
- Restore the icon after Explorer restarts (TaskbarCreated); close cleanly when the user signs out; do not create a visible application window.
- One tray process per interactive user session. Launch at user logon without elevation. Do **not** tie relay or agent lifetime to the tray process.
- No toast notifications, popups, graphs, settings dialog, remote repair, click-to-connect, or device control in v1.

The only periodic local work is a coarse freshness deadline check (30–60 seconds); normal status changes are pushed via the pipe. Never spin or refresh the menu at frame rate.

## 6. Security, coexistence, and reliability

- All presence data originates from a device-authenticated relay session and is scoped by the relay's account binding.
- The relay is authoritative for remote presence but never for local action policy.
- A tray crash, missing Explorer shell, inaccessible named pipe, or locked desktop cannot stop or restart tetherd or the relay.
- The tray must not move the mouse, steal focus, manipulate the physical clipboard, or modify human-owned resources.
- Treat every relay-provided device label as untrusted display data: validate length, escape/control-character-filter it, and cap the roster/message size.
- No credentials in UI, logs, diagnostics, IPC frames, screenshots, or tests.
- Revocation removes the device from the roster or clearly reflects it as unpaired (not connected).
- If a server restart resets connection generations, clients accept only a fresh snapshot from the newly authenticated session, never a cached state from the previous generation.
- No change to MCP/OAuth architecture is needed for presence transport. The existing separate MCP OAuth and end-to-end RPC verification work remains unresolved.

## 7. Resource budget and measurement

The intent is **minimum real measured overhead**, not a promise based on language choice alone.

- Target additional tray-process **private bytes < 15 MiB** after warm-up with four devices; investigate regressions above that. Do not accept an implementation over **20 MiB** without explicit review and a documented reason.
- Target near-zero idle CPU (< 0.1% average on representative Windows hardware, measured rather than assumed).
- Zero additional remote network connections per tray process. All presence rides the existing agent WebSocket.
- Bounded local IPC buffering and one compact in-memory snapshot; no embedded runtime or bundled browser.
- Target UI update within 2 seconds of the local agent receiving a presence change; disconnected remote sessions must be recognized within the liveness bound rather than only after an arbitrary operator refresh.

Measure private bytes, working set, CPU, and socket counts on representative Windows hardware after ten minutes at idle and during simulated churn. Compare agent-plus-tray memory to the same agent without the tray to avoid misrepresenting incremental overhead. The existing local-core agent memory target (< 50 MB idle) is an unverified design budget and must not be reported as a measured result.

## 8. Repository boundaries and implementation direction

Expected focused areas (final paths may adapt to existing layout during planning):

- relay/src/devices and relay/src/routing: account-scoped snapshot generation, opt-in WS delivery, liveness and revocation updates.
- relay/test and tests/e2e: version negotiation, account isolation, reconnects, revocations, freshness, backward compatibility.
- agent/tetherd/src/relay_ws.rs plus a small presence module: parse the optional presence message, apply sequence/freshness rules, publish locally, report unavailable when disconnected.
- A separate Windows-only Rust tray binary/crate using Win32 notification-area APIs, with isolated minimal unsafe FFI where unavoidable; keep the core agent's existing safety guarantees.
- Windows packaging/scripts: optional per-user tray logon start, without modifying existing relay or agent task identities as part of this feature.

No unrelated refactoring, new default MCP tools, task elevation changes, OAuth fixes, credential changes, or changes to the canonical internal capability model.

## 9. Test strategy (strict TDD during implementation)

1. **Red test first:** paired offline vs authenticated online; snapshot on join/leave/revoke; multi-account isolation; stable exact device IDs.
2. **Compatibility tests:** an unmodified agent receives no new presence messages; new agent opts in and still processes invoke/result correctly.
3. **Transport tests:** missed WebSocket Pong, TCP half-open, clean close, rapid reconnect, relay restart, generation/sequence replacement, bounded snapshots.
4. **Local IPC tests:** correct same-user access, cross-user denial, malformed frame rejection, pipe reconnect, agent shutdown, no credential exposure.
5. **Tray state tests:** green/red/amber/gray, four-device roster, exact freshness deadlines, unknown on feed loss, Explorer restart, logoff cleanup.
6. **Windows integration:** start tray with real authenticated agent and relay; disconnect one test agent, check offline transition, reconnect, verify recovery. No user-interfering foreground automation.
7. **Benchmark:** idle private bytes and CPU on all four devices, process count, no new outbound sockets.
8. **Repository gates:** Rust format, Clippy, tests; TypeScript typecheck/tests and relevant full repository verification. Re-run fresh gates before each completion or commit claim.

## 10. Explicit exclusions and rollout

Out of scope: fixing existing interactive Task Scheduler logon requirements on Vaulter/Surface; agent service installation overhaul; MCP OAuth redesign; proving remote RPC correctness; settings panels; alerts; monitoring history; persistent telemetry; tray-driven repairs.

Stage 1: implement and test on an isolated feature branch using the canonical Leno repository when reachable, or push reviewed code to canonical GitHub for subsequent Leno synchronization. Stage 2: validate on Leno first with synthetic and real four-device presence. Stage 3: install on Vaulter, RTX, and Surface only after tests and memory checks; verify no foreground disruption. Stage 4: separately harden unattended startup and authenticated MCP routing.

**Exit criteria:** The Windows notification area contains exactly one Tetherplane icon per signed-in session; opening it shows the actual four-device authenticated presence; changes and failures produce correct icon/menu states within bounds; the tray uses no additional network connections or secrets; resource budgets and relevant tests pass on all four devices. The Windows hidden-icons placement itself remains user-controlled.

## 11. Open implementation risks to resolve in the plan

- Exact Windows pipe ACL and identity mapping if the agent later runs as a service account different from the interactive user.
- Whether current relay socket heartbeat behavior already covers half-open connections, to avoid duplicate keepalive loops.
- Benchmark variance from Rust runtime and Windows UI libraries before treating the 15 MiB target as a release gate.

These risks must be settled through inspection and tests, not assumptions or blanket permission changes.
