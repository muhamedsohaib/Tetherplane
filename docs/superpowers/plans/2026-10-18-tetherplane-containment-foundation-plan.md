# Tetherplane Containment Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make restricted process execution fail closed until an OS-enforced, usable Windows read-only-workspace/private-scratch profile proves its access, lifecycle, and human-coexistence guarantees.

**Architecture:** Extend the existing Capability Kernel and local Policy Broker with a provider-neutral, trusted execution-profile decision. A process provider never interprets caller-supplied privilege assertions and never falls back to ambient host-account launch. A Windows isolation backend must establish access restrictions and process containment before untrusted execution; file operations, artifact exports, and local emergency stop use the same resource/effect ceiling.

**Tech Stack:** Rust edition 2024, Tokio, tether-core, tether-process-provider, Windows OS isolation behind safe audited library interfaces, SQLite for durable device security records, existing Rust and TypeScript end-to-end test infrastructure; Windows-hosted CI and explicitly authorized Leno acceptance.

**Spec:** `docs/superpowers/specs/2026-10-18-tetherplane-organizations-access-control-design.md`, approved at `c4fdc5a8cb69972828f95e66da0e2d97d57ed47d`.

**Execution order:** First of three plans. Next: `2026-10-18-tetherplane-organization-authority-plan.md`, then `2026-10-18-tetherplane-administration-personal-mode-plan.md`. These are independently reviewed engineering slices, not smaller public releases.

## Global Constraints

- Preserve exactly six default MCP tools: `device`, `files`, `process`, `browser`, `desktop`, `batch`.
- Preserve `background_only`, protected human resources, explicit ForegroundLease, and the local Policy Broker as final authority.
- Restricted code MUST NOT launch under the host account after an isolation failure; no cwd/environment/allowlist substitute or weaker PTY fallback.
- First Windows profile: read-only attached workspace, declared runtime read/execute dependencies, private writable scratch/configuration, no network including loopback, no privileged IPC, no human input/UI observation or interference.
- Real process evidence must include permitted work and denied off-scope reads/writes, descendant, credential, IPC, network and human-interface attempts; synthetic test-owned fixtures only.
- Windows Job Objects establish lifecycle/resource limits, not filesystem confinement; LPAC/AppContainer is a candidate, not proven compatibility.
- The repository currently sets `#![forbid(unsafe_code)]` and `scripts/check-no-unsafe.py` rejects authored unsafe Rust. Do not weaken either silently. If no safe reviewed OS binding can prove all controls, STOP and request a separate approved design change rather than importing unreviewed unsafe code or weakening guarantees.
- The existing process-provider tests exercise ambient shell spawning. Preserve regression coverage by introducing a test-only isolated launcher; do not keep an unrestricted production escape for test compatibility.
- Device-local emergency stop must work during management/audit outage, latch durably, and only terminate verified Tetherplane-owned process trees.
- No change to installed Leno agent, Smart App Control, Windows trusted signing, user files, credentials, pairings, or another device. Human-active acceptance requires a separate authorized time window.
- Fresh RED (correct failure) → minimum GREEN → focused regression → complete applicable repository gates → independent review → focused commit per task. Never claim Windows containment based only on mocked policy denials.

## Review Focus

1. A caller adds a fake `profile_id` or ``andbox_verified` argument: `restricted_process_rejects_caller_asserted_isolation` must deny without launching (Task 1).
2. Isolation configuration fails after a child object is allocated: `failed_setup_never_executes_child` must observe zero marker writes/process leaks (Task 3).
3. Workspace junction/symlink changes after authorization: `reparse_swap_cannot_escape_workspace` must deny actual open (Task 5).
4. Supervisor crashes while a confined descendant is running: `descendants_remain_confined_after_supervisor_exit` must show continued OS restrictions and confirmed containment/termination (Task 4).
5. An emergency-stop request names a recycled PID: `stop_rejects_reused_or_unowned_pid` must not kill an unrelated test process (Task 6).

## File Structure and Interfaces

| File | Responsibility |
| --- | --- |
| Create `agent/tether-core/src/execution_profile.rs` | Canonical `ExecutionProfile`, `ProfileResource`, `AuthorizedLaunch` and effect constraints; no OS/MCP types |
| Modify `agent/tether-core/src/policy.rs` | `LocalPolicyBroker::authorize_launch` intersecting exact grants and local ceiling |
| Modify `agent/tether-core/src/lib.rs` | Export canonical types only |
| Create `agent/providers/process/src/isolation.rs` | `IsolatedLauncher` boundary and deny-by-default unsupported backend |
| Create `agent/providers/process/src/windows_sandbox.rs` (Windows-only) | Verify and create OS-confined process using a reviewed safe platform API |
| Modify `agent/providers/process/src/{lib,session}.rs` | Require trusted launch, retain process ownership, disallow unchecked PTY |
| Create `agent/tetherd/src/security_state.rs` | Durable, guarded local stop/ownership state and transaction foundation |
| Create `agent/tetherd/src/emergency_stop.rs` | Local-only stop/recovery path independent of organization service |
| Modify `agent/providers/filesystem/src/{lib,read,write}.rs` | Stable target identity/preconditions and deny reparse/concurrent substitution |
| Create `agent/providers/filesystem/src/artifact_export.rs` | Broker-authorized verified scratch export |
| Test `agent/tether-core/tests/execution_profile.rs`, `agent/providers/process/tests/isolation.rs`, `agent/providers/process/tests/windows_isolation.rs`, `agent/providers/filesystem/src/filesystem_tests.rs`, `agent/tetherd/tests/emergency_stop.rs`, `tests/e2e/windows-containment.test.ts` | Unit, OS and cross-tool acceptance |

These interface names are decisions for this plan; implementers must preserve canonical provider-neutral types and not introduce a seventh MCP tool. The tenant-bound `AuthenticatedExecutionContext` is added by Plan 2; this plan's `AuthorizedLaunch` must carry identity fields that can be checked against that context without allowing untrusted arguments to mint it.

---

### Task 1: Trusted execution-profile and default-deny launch gate

**Files:**
- Create: `agent/tether-core/src/execution_profile.rs`
- Modify: `agent/tether-core/src/{lib,policy}.rs`
- Create: `agent/tether-core/tests/execution_profile.rs`
- Test: `agent/tether-core/tests/principal_policy.rs`

**Interfaces:**
- Produce: `ExecutionProfile { profile_id: String, revision: u64, organization_id: String, principal_id: String, device_id: String, enrollment_generation: u64, workspace: ProfileResource, scratch: ProfileResource, allowed_effects: BTreeSet<ExecutionEffect> }`.
- Produce: `LocalPolicyBroker::authorize_launch(&self, invocation: &InvocationEnvelope, profile: &ExecutionProfile) -> Result<AuthorizedLaunch, CapabilityError>`.
- `AuthorizedLaunch` is a non-serializable, privately constructed trusted value, never accepted from request JSON; the broker may issue it only after complete-grant/local-ceiling checks.

- [ ] **Step 1: Write the failing tests.** `restricted_process_rejects_caller_asserted_isolation`: with an authorized filesystem root but no validated execution profile, a `process.run` whose JSON contains fake `profile_id` and ``andbox_verified` is denied before provider call. `complete_profile_matches_org_principal_device_and_revision`: mismatched identities/resources/effects deny. `principal_policy.rs` retains caller-model neutrality.
- [ ] **Step 2: Confirm RED.** Run `cargo test -p tether-core --test execution_profile -- --nocapture`. Expected: test compilation fails because `ExecutionProfile`/`authorize_launch` are absent; the failure is not a broken fixture.
- [ ] **Step 3: Implement the minimum.** Add the exact types/function above; enforce read-only workspace vs scratch write modes, exact identity matching, no effect union from fragmented grants, and fail closed on unverified profile or unknown requirement. Keep constructor authority inside broker; no `serde::Deserialize` for `AuthorizedLaunch`.
- [ ] **Step 4: Confirm GREEN.** Run `cargo test -p tether-core --test execution_profile` and `cargo test -p tether-core --test principal_policy`. Expected: zero failures, including forged caller assertions and full-profile mismatch.
- [ ] **Step 5: Review/commit.** Inspect `git diff --check`; commit only the three named files with `git commit -m "feat(policy): require trusted restricted execution profiles"`.

### Task 2: Isolated launcher boundary with no ambient fallback

**Files:**
- Create: `agent/providers/process/src/isolation.rs`, `agent/providers/process/tests/isolation.rs`
- Modify: `agent/providers/process/src/{lib,session}.rs`, `agent/providers/process/tests/process.rs`, `agent/tetherd/src/runtime.rs`

**Interfaces:**
- Produce: `IsolatedLauncher::launch(&self, authority: &AuthorizedLaunch, program: &str, args: &[String], pty: bool) -> Result<ProcessSession, CapabilityError>`; a test-only fixture launcher can be injected through `ProcessProvider::with_isolated_launcher(...)`.
- Consume: Task 1's `AuthorizedLaunch`; the internal provider/run boundary receives it out of band from untrusted `InvocationEnvelope.arguments`. Update `CapabilityRouter`/provider dispatch narrowly if necessary so plain JSON cannot recreate trusted launch authorization.

- [ ] **Step 1: Write the failing tests.** `restricted_process_requires_injected_authorized_launch`, `unsupported_pty_returns_capability_unavailable_without_spawn` and `bad_isolation_setup_never_calls_host_command`. Adapt existing shell/output tests to the explicit test-isolated launcher, without a production privileged fallback.
- [ ] **Step 2: Confirm RED.** Run `cargo test -p tether-process-provider --test isolation`. Expected: missing isolated launcher contract and accidental host-launch test failure.
- [ ] **Step 3: Implement the minimum.** Route all restricted `process.run` through the trusted launcher, retain current bounded output/read/input semantics, prohibit ordinary `tokio::process::Command::spawn` and `portable_pty` in restricted production dispatch, and keep unverified PTY unavailable.
- [ ] **Step 4: Confirm GREEN.** Run `cargo test -p tether-process-provider --test isolation` and `cargo test -p tether-process-provider --test process -- --test-threads=1`. Expected: zero failures; existing process output tests use the isolated fixture.
- [ ] **Step 5: Review/commit.** Run `git diff --check` and `python scripts/check-no-unsafe.py`; commit `git commit -m "feat(process): close ambient subprocess fallback"`.

### Task 3: Windows isolation feasibility and verified creation-before-execution

**Files:**
- Create: `agent/providers/process/src/windows_sandbox.rs`, `agent/providers/process/tests/windows_isolation.rs`
- Modify: `agent/providers/process/Cargo.toml` and `agent/providers/process/src/isolation.rs`

**Interfaces:**
- Produce: Windows implementation of `IsolatedLauncher::launch`, exposing `supported_profile(&ExecutionProfile) -> Result<VerifiedPlatformGuarantees, CapabilityError>` before allowing dispatch.
- The first supported profile has no network, loopback, privileged IPC, host credentials, human-interface access, or host-workspace writes; launch and Job Object attachment must precede untrusted execution.

- [ ] **Step 1: Write Windows RED tests** with fixture-owned files and process markers: `read_only_workspace_and_private_scratch_are_enforced`, `failed_setup_never_executes_child`, `loopback_network_and_host_credentials_denied`, `human_input_clipboard_window_read_denied`, `unsupported_pty_denied`.
- [ ] **Step 2: Confirm RED.** On an isolated Windows CI runner, run `cargo test -p tether-process-provider --test windows_isolation -- --nocapture`. Expected: profile unavailable / tests fail for a missing implementation; do not switch to an unrestricted launch.
- [ ] **Step 3: Implement the minimum OS backend** using a reviewed safe Windows API abstraction for LPAC/AppContainer-capable access isolation plus lifecycle controls. Verify token, access-check restrictions, handle inheritance, desktop/window station isolation, and Job Object assignment **before resume/execution**. The implementation must not mutate human ACLs or install a general privileged bridge. If a safe backend is impossible under the existing authored-unsafe ban, STOP: publish feasibility evidence and seek a separate narrowly scoped security-design decision.
- [ ] **Step 4: Confirm GREEN only with native evidence.** Run the same `cargo test -p tether-process-provider --test windows_isolation -- --nocapture` on the supported Windows build. Expected: permitted read/compute/scratch write plus all negative checks succeed. Record OS build, executable version, profile revision; distinguish proven piped mode from unavailable PTY.
- [ ] **Step 5: Review/commit only if GREEN.** Run `cargo clippy -p tether-process-provider --all-targets -- -D warnings` and `python scripts/check-no-unsafe.py`; commit `git commit -m "feat(windows): prove confined process launch"`. On feasibility failure, remain fail-closed and report blocker without declaring this task complete.

### Task 4: Descendant confinement, sandbox ownership, and crash behavior

**Files:**
- Modify: `agent/providers/process/src/{isolation,session,lib}.rs`
- Create: `agent/providers/process/tests/isolation_lifecycle.rs`
- Modify: `agent/tether-core/src/ownership.rs`

**Interfaces:**
- Produce: `SandboxOwnerKey { organization_id, principal_id, device_id, enrollment_generation, job_id, profile_revision }`; ownership is established by trusted launch, never a PID supplied by a caller.
- Consume: Task 3 verified sandbox backend and Task 2 session handles.

- [ ] **Step 1: Write failing tests.** `descendants_remain_confined_after_supervisor_exit`, `cross_principal_scratch_and_handles_denied`, `child_cannot_inherit_privileged_pipe`, and `wrong_organization_cannot_input_or_terminate_handle`. Tests use disposable synthetic Windows processes.
- [ ] **Step 2: Confirm RED.** Run `cargo test -p tether-process-provider --test isolation_lifecycle` on hosted Windows. Expected: ownership/lifecycle checks fail correctly.
- [ ] **Step 3: Implement minimum ownership and OS lifecycle** with non-reused sandbox identities, private temporary resources, bounded descendant tree, inherited-handle allowlist, OS-held job containment, and verifiable termination evidence. No PID-only ownership decision and no access to privileged Tetherplane endpoints.
- [ ] **Step 4: Confirm GREEN.** Re-run the focused Windows suite and `cargo test -p tether-core --test ownership`. Expected: all assertions pass without manipulating human processes.
- [ ] **Step 5: Review/commit.** Inspect diff/ownership invariants and commit `git commit -m "feat(process): enforce sandbox ownership and descendant lifetime"`.

### Task 5: Stable-handle filesystem and cross-tool authorization

**Files:**
- Modify: `agent/providers/filesystem/src/{lib,read,write}.rs` and `agent/providers/filesystem/src/filesystem_tests.rs`
- Modify: `agent/tether-core/src/policy.rs`, `agent/tether-core/src/batch.rs`, `agent/providers/search/src/lib.rs`
- Create: `tests/e2e/organization-effect-isolation.test.ts`

**Interfaces:**
- Produce: `AuthorizedFileTarget` (opaque stable identity) resolved at final IO operation, and `authorize_resource_effect(resource, effect, context)` applied to all file/search/upload/batch children.
- Consume: Task 1 `ExecutionProfile` and Task 4 sandbox owner; Plan 2 provides organization-bound context before organization deployment.

- [ ] **Step 1: Write failing tests.** `reparse_swap_cannot_escape_workspace` with a redirected test-owned junction/symlink, `read_only_workspace_refuses_delete_or_replace`, `search_batch_upload_cannot_access_sibling_root`, and `forbidden_effect_cannot_be_reclassified_as_process_run`.
- [ ] **Step 2: Confirm RED.** Run `cargo test -p tether-filesystem filesystem_tests` and `node --test tests/e2e/organization-effect-isolation.test.ts` (after building existing e2e dependencies). Expected: missing handle/effect confinement assertion fails.
- [ ] **Step 3: Implement minimum** stable-handle/OS-enforced reparse-safe open and destination precondition semantics. Recheck authority at actual access, not only initial canonicalization. Prevent confined programs from reaching more-privileged browser bridges, document helpers, search or network-enabled endpoints. Maintain existing per-file functionality outside explicitly unavailable execution profiles.
- [ ] **Step 4: Confirm GREEN.** Re-run the targeted Rust and Node tests. Expected: no off-scope reads/writes, symlink/reparse escape, cross-tool bypass, or silent ACL broadening.
- [ ] **Step 5: Review/commit.** Run `cargo fmt --all -- --check`, `git diff --check`; commit `git commit -m "feat(files): recheck actual resource and effect boundaries"`.

### Task 6: Artifact export and durable device-local emergency stop

**Files:**
- Create: `agent/providers/filesystem/src/artifact_export.rs`, `agent/tetherd/src/security_state.rs`, `agent/tetherd/src/emergency_stop.rs`
- Create: `agent/tetherd/tests/emergency_stop.rs`
- Modify: `agent/providers/filesystem/src/lib.rs`, `agent/tetherd/src/{main,runtime}.rs`, `agent/tetherd/Cargo.toml`

**Interfaces:**
- Produce: `SecurityState::set_stop_latch(reason: &str) -> Result<(), CapabilityError>`; `EmergencyStop::stop_owned(&self, owner: &SandboxOwnerKey) -> StopReport` with explicit `requested`, `confirmed`, `cleanup_verified` states; `export_artifact(approved: AuthorizedExport) -> Result<VerifiedArtifact, CapabilityError>`.
- Device state uses a transactionally durable security store with verified patched SQLite (bundled audited library), guarded single-owner use and no authored unsafe Rust. Future Plans 2/3 extend this store rather than forking it.

- [ ] **Step 1: Write failing tests.** `emergency_stop_persists_offline_and_restart`; `stop_rejects_reused_or_unowned_pid`; `failed_stop_latch_commit_reports_unverified`; `artifact_export_rejects_changed_digest_or_destination` and `read_only_attached_workspace_never_mutated_by_export_process`.
- [ ] **Step 2: Confirm RED.** Run `cargo test -p tetherd --test emergency_stop`. Expected: absent durable stop and verified owned-tree status make the tests fail.
- [ ] **Step 3: Implement minimum** authenticated local-only emergency stop (not a public unauthenticated RPC), bounded owned-tree termination, durable stop latch and explicit recovery, and brokered artifact export binding source/destination identities and preconditions. Never overwrite Leno's unmanaged installation or let an agent outage clear the latch. Extend `security_state` with transactional schema for Plan 2 snapshots and Plan 3 approval/idempotency, without implementing those features prematurely.
- [ ] **Step 4: Confirm GREEN.** Run `cargo test -p tetherd --test emergency_stop` and `cargo test -p tether-filesystem`. Expected: stop survives restart, unowned processes untouched, export verified, storage errors fail closed.
- [ ] **Step 5: Review/commit.** Check no secrets and no blanket ACL changes; commit `git commit -m "feat(device): add durable local stop and verified exports"`.

### Task 7: Native containment integration and first security handoff

**Files:**
- Create: `tests/e2e/windows-containment.test.ts`
- Modify: `.github/workflows/ci.yml` and `docs/onboarding/WINDOWS-CODE-SIGNING.md` only if the tested runtime/profile compatibility matrix changes the package contract
- Create: `docs/security/organizations-execution-profiles.md`

**Interfaces:**
- Produce: a support matrix for exact Windows build, profile version, runtime commands, piped/PTY modes and independently observed guarantees; retain `capability_unavailable` for unverified combinations.
- AC coverage: `AC-06`, `AC-07`, `AC-08`, `AC-17` and relevant `AC-19`/`AC-20`; others remain blocked pending Plans 2/3.

- [ ] **Step 1: Write failing end-to-end checks.** `permitted_read_compute_and_export`; `negative_offscope_symlink_network_ipc_credentials_human_observation`; `descendant_crash_tree_and_stop`; `batch_and_browser_bridge_no_escalation`. Tests use only runner-owned synthetic fixtures.
- [ ] **Step 2: Confirm RED.** Run `node --test tests/e2e/windows-containment.test.ts` on an isolated GitHub-hosted Windows job after compiling the current agent. Expected: unsatisfied native isolation assertions, not arbitrary setup failure.
- [ ] **Step 3: Integrate profile probing and evidence** into the existing CI without granting untrusted code elevated privileges or touching a human workstation. Pin supported commands and documented disabled modes; publish concise test reports. Leno live/human-active acceptance stays a separately authorized gate.
- [ ] **Step 4: Confirm GREEN and broader gates.** Run `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace -- --test-threads=1`, `python scripts/check-no-unsafe.py`, `pnpm -r typecheck`, `pnpm -r test` and `pnpm -r build`. Obtain fresh hosted Windows and Ubuntu results for the same SHA. Any failing test stops the task.
- [ ] **Step 5: Review/commit.** Commit `git commit -m "test(security): verify native containment and publish supported profiles"` after real tests; leave draft/unreleased if any native, coexistence, signing or operator window remains unverified.

## Completion and Handoff

- Mark each item only after its named RED/GREEN and latest applicable broad gates; do not convert a feasibility failure into an available profile.
- The containment phase alone is NOT the organizations-first release: all `AC-01` through `AC-22` still require end-to-end proof after Plans 2/3.
- Before any commit or PR, inspect `git status`, branch, recent log, remote, worktree ownership, and current difference against the reviewed spec. Use isolated feature worktrees; never overwrite the dirty Leno canonical checkout or signing worktree.
- Windows trusted public-signing eligibility, real installation, migration, foreground coexistence and financial/external actions each retain separate approval gates.
