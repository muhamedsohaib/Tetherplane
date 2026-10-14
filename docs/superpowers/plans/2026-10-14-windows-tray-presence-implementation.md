# Windows Native Tray Presence Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display authoritative account-scoped Tetherplane device presence in one minimal native Windows notification-area icon and menu, with no separate remote connection or interactive disruption.

**Architecture:** The Node relay derives account-scoped online/offline snapshots from its existing authenticated WebSocket routing table; only agents that negotiate presence-v1 receive pushed snapshots on their existing authenticated socket. The Rust agent validates and stores snapshots, exposes read-only data to the same-user tray via a bounded Windows named pipe, and a separate Rust/Win32 user-session executable renders a single shell icon.

**Tech Stack:** TypeScript/Node 22, ws 8, Rust (workspace toolchain), tokio, Tokio Windows named pipe, thin Win32/Shell_NotifyIcon FFI, Windows PowerShell packaging, Node test runner, Cargo tests, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-windows-tray-presence-design.md`

## Global Constraints

- Exactly six default AI-facing MCP tools: `device`, `files`, `process`, `browser`, `desktop`, `batch`.
- Preserve Kernel, Providers, Adapters, Transport, and Policy Broker separation; local agent is final authority.
- Default `background_only`; no foreground focus, physical cursor, clipboard, human tab, or human-process modification.
- Presence is not equivalent to TCP reachability. Online must mean an account-matched authenticated live WebSocket session within liveness bounds.
- Never send device secrets, credentials, OAuth tokens, or remotely controllable commands to the tray.
- Existing agents MUST NOT receive unsolicited new protocol messages.
- No additional outbound network connections per tray; no public status endpoint or new OAuth flow.
- One icon per signed-in Windows session; no elevation; agent and relay must work without the tray.
- Target tray private bytes < 15 MiB after warm-up, review any implementation above 20 MiB; idle CPU target < 0.1%; benchmark before claims.
- Follow current `MIT OR Apache-2.0` workspace licensing; package both complete license texts.
- Do not change the currently live Vaulter/RTX/Surface task registration or device credentials in implementation commits.

## Review Focus

1. **An older deployed tetherd connects:** send only the existing invoke schema, not presence snapshots; assert legacy RPC still works in Task 3.
2. **TCP half-open / delayed Pong:** transition live account presence to offline within the 90-second bound; assert in Task 4.
3. **A malicious neighboring Windows user opens the named pipe:** deny access without leaking roster/credentials; assert in Task 7.
4. **A relay restarts during a green tray display:** immediately switch to unknown and reject stale generations; assert in Task 5/7.
5. **Explorer restarts or a user signs out:** recreate one icon after TaskbarCreated; clean up without killing or disturbing the agent; assert in Task 8.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `relay/src/routing/device-router.ts` | Expose account-scoped currently connected IDs without changing routing |
| `relay/src/devices/presence.ts` (new) | Pure snapshot builder and snapshot types/limits |
| `relay/src/devices/ws-gateway.ts` | Presence-v1 negotiation, snapshot fanout, optional heartbeat |
| `relay/src/devices/control-http.ts` | Notify gateway on post-revoke roster change through existing route |
| `relay/test/presence.test.ts` (new) | Snapshot/account scope/reconnect/upgrade/heartbeat tests |
| `agent/tetherd/src/presence.rs` (new) | Typed snapshot validation, generation and freshness rules |
| `agent/tetherd/src/relay_ws.rs` | Capability negotiation; multiplex invoke and presence frames; failure state |
| `agent/tetherd/src/presence_ipc.rs` (new, Windows-gated) | Read-only same-user bounded named-pipe snapshot delivery |
| `agent/tetherd/src/main.rs` | Initialize presence state and pipe only in relay mode |
| `ui/tetherplane-tray/Cargo.toml` (new) | Separate small Windows tray package with workspace license |
| `ui/tetherplane-tray/src/state.rs` (new) | Pure icon/menu health and timeout model |
| `ui/tetherplane-tray/src/pipe.rs` (new) | Local reader, bounded frames, reconnect |
| `ui/tetherplane-tray/src/windows.rs` (new) | Minimal Win32 shell/icon/menu window interop |
| `ui/tetherplane-tray/src/main.rs` (new) | Tray lifetime, OS session integration |
| `scripts/package-windows.ps1`, `scripts/install-windows.ps1`, `scripts/uninstall-windows.ps1` | Optional tray packaging, install and uninstall without touching human processes |
| `tests/release/windows-package-smoke.ps1` | Side-by-side tray package and install contract |
| `docs/remote/self-host.md`, `README.md` | Operator behavior and status meaning |

## Task 1: Establish Clean Baseline and Test Environment

**Files:** Existing `Cargo.toml`, `.github/workflows/ci.yml`, `relay/package.json`. No product source changes in this task.

**Interfaces:** Produces an independently recorded baseline of test commands/results and current branch SHA.

- [ ] **Step 1: Inspect Git state on Leno:** run `git status --short`, `git branch --show-current`, `git log --oneline --decorate -5`, `git remote -v`; do not overwrite a dirty working tree.
- [ ] **Step 2: Isolate work:** use a dedicated local feature worktree from the approved design/plan branch; reconcile with canonical GitHub and preserve all existing feature branches.
- [ ] **Step 3: Run existing gates:** `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`.
- [ ] **Step 4: Record outcomes:** if Clippy fails on Rust 1.99 `assert_is_empty`, reproduce and resolve it in a separate focused release-hardening task/commit before using CI green as evidence; do not suppress the lint.

## Task 2: Pure Account-Scoped Snapshot Model

**Files:**
- Create: `relay/src/devices/presence.ts`
- Modify: `relay/src/routing/device-router.ts`
- Test: `relay/test/presence.test.ts`

**Interfaces:**
- `DeviceRouter.onlineDeviceIds(accountId: string): readonly string[]`
- `buildPresenceSnapshot(input: { accountId: string; registry: DeviceRegistry; router: DeviceRouter; generation: string; sequence: number; observedAt: string }): PresenceSnapshotV1`
- `PresenceSnapshotV1 = { type: "presence.snapshot"; version: 1; generation: string; sequence: number; observed_at: string; devices: { device_id: string; status: "online"|"offline" }[] }`

- [ ] **Step 1: Write failing test** `account_snapshot_lists_only_nonrevoked_same_account_devices`: construct two accounts with online/offline/revoked devices; assert exact IDs, stable order, statuses, and no device from the second account.
- [ ] **Step 2: Run `pnpm --filter @tetherplane/relay test`** and verify this new test fails for the missing export.
- [ ] **Step 3: Implement model** with account filtering and bounded device count (256 max; if exceeded fail closed), using existing `registry.listDevices` and `router` connection authority; never serialize credentials.
- [ ] **Step 4: Rerun focused relay tests** and confirm pass; commit `feat(relay): derive account-scoped presence snapshots`.

## Task 3: Explicit Backward-Compatible Presence Subscription

**Files:**
- Modify: `relay/src/devices/ws-gateway.ts`
- Test: `relay/test/presence.test.ts`, `relay/test/device-ws.test.ts`

**Interfaces:**
- On WebSocket upgrade, accept optional `x-tetherplane-presence-version: 1` only after existing device credential authentication.
- `DeviceWebSocketGateway.publishPresence(accountId: string): void` fans out complete snapshots only to authenticated opted-in sockets; each source session uses a fresh generation UUID and incrementing sequence.

- [ ] **Step 1: Write failing tests**: new agent receives an initial `presence.snapshot`; legacy agent receives no unsolicited frames; connect/disconnect/revoke broadcasts only to subscribed sockets in the same account; malformed negotiation does not enable presence.
- [ ] **Step 2: Run `pnpm --filter @tetherplane/relay test`** and verify intended new tests fail.
- [ ] **Step 3: Implement negotiated delivery**, including a new account-scoped generation/sequence per subscriber; invoke `publishPresence` from the gateway's connect/disconnect and existing control-http revoke flow, with a single nonblocking broadcaster.
- [ ] **Step 4: Run relay tests**, verify unchanged legacy `device-ws` routing, and commit `feat(relay): negotiate and broadcast presence-v1`.

## Task 4: Liveness and Bounded Stale-Connection Detection

**Files:**
- Modify: `relay/src/devices/ws-gateway.ts`
- Test: `relay/test/presence.test.ts`, `relay/test/device-ws.test.ts`

**Interfaces:**
- Gateway constructor accepts optional `heartbeatIntervalMs`, `heartbeatTimeoutMs` (production default 30s/90s).
- Only confirmed open and liveness-valid sessions count as online.

- [ ] **Step 1: Write failing tests** for half-open legacy and new sockets: missed Pongs cause disconnection and offline snapshot by 90 seconds; timely Pongs retain online; socket close/relay shutdown cleans timers.
- [ ] **Step 2: Run relay tests** and confirm failed heartbeat expectations.
- [ ] **Step 3: Implement one gateway-owned Ping/Pong heartbeat** for all device sockets; avoid extra intervals per subscriber when one gateway-level timer suffices.
- [ ] **Step 4: Rerun focused and existing device WebSocket tests** and commit `fix(relay): bound device presence liveness`.

## Task 5: Agent Snapshot Parser and Freshness Store

**Files:**
- Create: `agent/tetherd/src/presence.rs`
- Modify: `agent/tetherd/src/relay_ws.rs`, `agent/tetherd/src/main.rs`
- Test: inline `#[cfg(test)]` modules and `tests/e2e/remote-plane.test.ts`

**Interfaces:**
- `PresenceStore::replace(&mut self, snapshot: PresenceSnapshotV1, received_at: Instant) -> Result<(), PresenceError>`
- `PresenceStore::current(&self, now: Instant) -> PresenceView`; stale >90s returns unknown.
- `PresenceStore::mark_unavailable(&mut self)`; `PresenceView = Unknown | Available(Vec<DevicePresence>)`.
- Only relay transport mode advertises the capability header and enables presence parsing.

- [ ] **Step 1: Write failing Rust tests** for schema, maximum roster/frame length, invalid characters, unsorted or duplicated IDs, generation switch, stale sequence and timeout; assert unknown on disconnect.
- [ ] **Step 2: Run `cargo test -p tetherd presence`**; verify failing expectations.
- [ ] **Step 3: Implement store and dispatch**: incoming `invoke` unchanged, opt-in `presence.snapshot` delivered to store, on reconnect clear old state; no local policy bypass.
- [ ] **Step 4: Run Rust focused tests and the black-box remote-plane E2E test**; commit `feat(tetherd): validate and cache relay presence`.

## Task 6: Local-Only Agent Snapshot IPC

**Files:**
- Create: `agent/tetherd/src/presence_ipc.rs`
- Modify: `agent/tetherd/src/main.rs`, `agent/tetherd/Cargo.toml`
- Test: `agent/tetherd/src/presence_ipc.rs` tests and Windows-only integration tests

**Interfaces:**
- `PresenceIpc::serve(store: Arc<PresenceWatch>, pipe_name: &str) -> Result<(), PresenceIpcError>`; sends length-bounded versioned JSON snapshots and unknown state.
- Client-to-agent channel is not an RPC interface; no device invocation commands accepted.

- [ ] **Step 1: Write failing Windows IPC tests**: correct local user can subscribe; a distinct user token is rejected; overlong frame and unreadable state fail closed; relay loss yields unknown without killing agent.
- [ ] **Step 2: Run Windows `cargo test -p tetherd presence_ipc`**, verify tests fail for missing IPC.
- [ ] **Step 3: Implement a Tokio Windows named pipe** with a deliberately restricted user/security descriptor and bounded output buffer. Never widen ACL to Everyone; if secure same-user delivery cannot be proved for a deployment identity, the UI must remain unknown.
- [ ] **Step 4: Rerun Windows IPC tests** and commit `feat(tetherd): expose read-only local presence pipe`.

## Task 7: Platform-Neutral Tray Health and IPC Client

**Files:**
- Create: `ui/tetherplane-tray/Cargo.toml`, `ui/tetherplane-tray/src/state.rs`, `ui/tetherplane-tray/src/pipe.rs`, `ui/tetherplane-tray/src/main.rs`
- Modify: workspace `Cargo.toml`, `Cargo.lock`
- Test: Rust unit tests in `state.rs` and `pipe.rs`

**Interfaces:**
- `TrayState::apply(view: PresenceView, now: Instant) -> TrayDisplay` with `TrayDisplay { icon: Green|Red|Amber|Gray; rows: Vec<Row>; summary: String }`.
- `PipeSubscriber::run(pipe_name: &str, on_snapshot: impl Fn(PresenceView))`; bounded local-only read with reconnection.

- [ ] **Step 1: Write failing tests** for all-online green, offline red, nearing freshness amber, unavailable/expired gray, exact four IDs, overly long names and sequence replacement.
- [ ] **Step 2: Run `cargo test -p tetherplane-tray`** and verify intended failures.
- [ ] **Step 3: Implement pure state and pipe reader** without a browser, framework or extra remote sockets; prove malformed data cannot crash the rendering state machine.
- [ ] **Step 4: Rerun tray Rust tests** and commit `feat(tray): model status and consume local presence`.

## Task 8: Win32 Shell Notification Icon and Menu

**Files:**
- Create: `ui/tetherplane-tray/src/windows.rs`
- Modify: `ui/tetherplane-tray/src/main.rs`, `ui/tetherplane-tray/Cargo.toml`
- Test: `ui/tetherplane-tray` Windows-only smoke tests

**Interfaces:**
- `TrayWindow::new() -> Result<Self, TrayError>`, `TrayWindow::render(display: &TrayDisplay) -> Result<(), TrayError>`, `TrayWindow::run(&mut self) -> Result<(), TrayError>`.
- Isolate any unavoidable `unsafe` Win32 calls to the FFI-only module; document safety invariants and disallow unsafe in agent crates.

- [ ] **Step 1: Write failing Windows smoke tests** that assert one icon/menu, four rows, correct status label and tooltip, icon restoration on `TaskbarCreated`, and tray disposal on user logoff.
- [ ] **Step 2: Run `cargo test -p tetherplane-tray --target x86_64-pc-windows-msvc`** on Windows; verify failures.
- [ ] **Step 3: Implement `Shell_NotifyIconW` and standard menu handling**, with no visible window, focus-stealing control, custom WebView, or foreground automation.
- [ ] **Step 4: Rerun Windows tray smoke and new Rust tests**; commit `feat(tray): render native Windows notification icon`.

## Task 9: Optional Side-by-Side Windows Packaging

**Files:**
- Modify: `scripts/package-windows.ps1`, `scripts/install-windows.ps1`, `scripts/uninstall-windows.ps1`, `tests/release/windows-package-smoke.ps1`
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Test: `tests/release/windows-package-smoke.ps1`

**Interfaces:**
- Package `bin/tetherplane-tray.exe` with existing licenses.
- Installer opt-in `-InstallTray` (off by default), creates one per-user logon entry, records it in install receipt, rejects collision with non-Tetherplane-owned entry. Uninstall removes only receipt-owned entry/process; never modifies production user's unrelated scheduled tasks.

- [ ] **Step 1: Write failing package-smoke checks** for tray artifact, explicit opt-in, no extra default task, idempotent install/uninstall, and preservation of unrelated registry/processes.
- [ ] **Step 2: Run `./tests/release/windows-package-smoke.ps1`** in a temporary side-by-side install and verify intended failure.
- [ ] **Step 3: Add packaging and opt-in per-user startup**, updating release workflow and build; include MIT and Apache license texts.
- [ ] **Step 4: Rerun Windows package and install/uninstall smoke**; commit `build(windows): package optional native tray`.

## Task 10: Real-Mesh Validation, Benchmarks and Documentation

**Files:**
- Modify: `tests/e2e/remote-plane.test.ts`, `README.md`, `docs/remote/self-host.md`
- Create: `docs/benchmarks/windows-tray-presence-2026-10-14.md` (write only after measurement; use true date and SHA if later)

**Interfaces:** Uses the actual presence protocol, local pipe, tray state, and package from Tasks 2–9.

- [ ] **Step 1: Write black-box tests**: four independently authenticated device connections, authoritative roster, unplug/reconnect, no stale green after relay shutdown, account isolation, revoke, old agent RPC unaffected.
- [ ] **Step 2: Run `pnpm -r test`, `cargo test --workspace`, and `node --test tests/e2e/remote-plane.test.ts`**; verify new tests fail before filling any missing integration.
- [ ] **Step 3: Finish smallest integration behavior and README/self-host documentation**, defining each status and that tray depends on the signed-in shell but relay/agent do not.
- [ ] **Step 4: Run fresh full gates**: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`, `python scripts/check-no-unsafe.py`, `./tests/release/windows-package-smoke.ps1` on Windows, and GitHub CI for both OSes.
- [ ] **Step 5: Measure** idle 10-minute private bytes, working set, CPU, extra outbound socket count, disconnect reaction, and live menu states on Leno; extend to Vaulter, RTX, Surface using operator-scoped permission and non-foreground automation.
- [ ] **Step 6: Record actual benchmark results and limitations**; do not claim <15 MiB or end-to-end RPC unless proven. Commit `test(docs): verify native tray integration and resource baseline`.

## Exit and handoff

- All focused and repository gates green with fresh evidence and reviewable commits on a task branch, no force-push to main.
- One tray icon per Windows user session and accurate status on all four devices; no extra network connection, credentials, WebView, foreground interruption, or process interference.
- Packaging installs and uninstalls cleanly, without changing existing production tasks; the release candidate contains both license texts.
- If real-device testing requires physical desktop access, obtain a scoped user session and record blockers instead of claiming deployment.
- Then run the **separate connector/recovery hardening and licensed release plan**. No release tag before that plan's gates pass.
