# Windows notification toasts — scoped UX extension (draft)

Date: 2026-11-03
Status: isolated, tested policy/native-dispatch prototype; not wired to agent, trusted IPC or signed Store app
Base: Windows tray-presence design 2026-10-14
Scope: native user-session notification presenter; no second network client, control plane, or OAuth client.

## User-facing outcomes
- One passive tray icon continues to show current authenticated presence for Leno, VAULTER, RTX and Surface.
- Windows notification-center toasts make important changes visible without opening a terminal.
- A toast never grants pairing, changes scopes, launches a remote operation, or treats network reachability as authenticated presence.

## Severity and triggers
1. Connection restored: one confirmation after authenticated WebSocket session and optional live status proof; avoid misleading success claims.
2. Device disconnected: notification only after the existing bounded liveness determination; do not infer from ping or app-process status.
3. Pairing request: show safe source label and request timeout; Review opens the trusted local pairing UI, not an automatic allow.
4. Approval required: show device plus capability class and expiry, no sensitive arguments; Review opens the existing scoped approval interaction.
5. Approval denied or expired: informational outcome; do not invite bypass or implicit retry.
6. Setup action needed: relay unavailable or pairing incomplete; actionable explanation and local diagnostics, no raw credentials or endpoint tokens.
7. Permission revoked: high-priority notification; subsequent operations fail closed.

## Noise controls
- Default off for repetitive online/offline churn; notify only on user-relevant state transitions.
- Deduplicate identical category/device events within 5 minutes (design choice subject to user testing).
- After 3 changes in 10 minutes, collapse into one 'connection unstable' toast.
- No toast on each heartbeat, process poll, or background RPC.
- Respect Windows Focus Assist / Do Not Disturb and user notification settings; tray remains informative independently.
- Limit displayed device labels to validated printable characters and bounded length.

## Architecture and safety
- Relay remains authority for account-scoped authenticated presence; local agent remains final authority for device actions.
- Existing opt-in presence stream, if implemented and independently verified, is the read-only state source.
- Separate per-user native notification presenter uses only authenticated local IPC with explicit ACLs; no new outbound sockets.
- No shared clipboard, keyboard focus, foreground window manipulation, or taskbar placement changes.
- Do not expose auth tokens, pairing secrets, local file paths, relay URL query parameters, process command lines or private device data in toast body or logs.
- Review action deep-links only to verified local owner UI. It does not transmit an approval decision.
- If the agent/relay feed is missing or stale, show Unknown instead of Connected.
- Toast process failure cannot stop the relay or device agent.

## Initial acceptance gates
- Unit: event classification, state-change detection, dedupe, throttling, stale->unknown, safe labels, clock boundaries.
- Security: no silent approval from toast action; reject spoofed IPC requests, cross-user pipe access, replayed approval events and malformed frames.
- Integration: delivered to Windows Notification Center from packaged signed identity; review action routes into real owner UI.
- Reliability: Explorer restart, notification suppression, logoff/logon, relay dropout, rapid reconnect and revocation.
- Four-device acceptance: verify Leno, VAULTER, RTX and Surface independently; do not claim success from mock data.
- Performance: benchmark warm idle CPU/private bytes; unchanged agent lifetime and zero additional outgoing sockets.
- Release: draft feature branch only; do not merge, ship, change Store signing, install packages, OAuth configuration or production identity.


## Implementation checkpoint — 2026-11-03

- Code: `agent/tether-notifications` introduces a passive `NotificationPolicy`, safe text-only toast XML, and a Windows-native `ToastNotificationManager` sender with an explicit manual diagnostic binary.
- Verification: on Vaulter Windows, Rust 1.98.1 / gnullvm using offline dependencies and existing rust-lld, `cargo fmt --all -- --check` passed, `cargo test --offline -p tether-notifications` passed **10/10**, and `cargo clippy --offline -p tether-notifications --all-targets -- -D warnings` passed.
- SHA-256 equivalence for the tested formatted source on Vaulter and canonical Leno worktree confirmed for `lib.rs`, `windows_native.rs`, and the diagnostic binary source.
- Leno Windows Code Integrity event 3077 denied loading `rustc_driver` in the local Rust toolchain, so the Rust gates could not execute on Leno. No host security policy was changed.
- `cargo metadata --offline --no-deps --format-version 1` and `git diff --check` passed on Leno.
- **Not proved:** no authenticated presence/approval event integration; no trusted local IPC transport; no packaged app identity or runtime toast display acceptance; no four-device test; no signed release, deployment or install.
- The diagnostic smoke binary requires explicit `--smoke --registered-app-id` parameters, displays only a synthetic status-neutral test and cannot invoke device actions. Do not treat a successful WinRT `Show` call as proof that a toast appeared in Notification Center.
- This worktree remains draft-only. Before any production integration, preserve the relay/agent authentication boundaries, add trusted source verification, packaged-app activation plumbing, and actual Windows desktop acceptance.
