# Vaulter guarded orphan recovery — source repair and NO-GO record

Date: 2026-10-13 (Asia/Dubai).
Canonical repository: https://github.com/muhamedsohaib/Tetherplane
Base: d0778b7d09de744de863ca61a43f6ddacdc39a69.
Branch: fix/vaulter-guarded-orphan-recovery-20261013.

Status: child-lifetime source fix independently verified; **live supervision NOT restored**.
No live relay stop, task mutation, protected-stage replacement, Auth0 change,
PostgreSQL operation, Holter operation, or unrelated-process termination occurred.

## Read-only incident evidence

- Hostname command returned vaulter.
- Canonical supervision preflight returned TASK_INACTIVE_LISTENER_PRESENT.
- Task state Ready; protected supervisor stage and exact registered action verified.
- Exclusive loopback relay, local/public health, public readiness, auth health,
  and unchanged Auth0 issuer verified.
- Task-owned process chain was NOT verified.
- Observed relay Node PID 4212, parent launcher PID 6024, absent grandparent 4824.
  Launcher creation: October 11 16:02:55; Node creation: 16:02:57 (+04:00).
  These are historical evidence, never reusable termination targets.
- Redacted TaskScheduler/Operational records 3277–3279 at October 11
  16:02:40.081 (+04:00) identify process 4824 as the relay task engine.
  This corroborates historical ancestry; it does not prove current supervision
  or authorize adopting/terminating an existing process.
- Separate auth listener PID 6360 remains on loopback 8790.

## Reproduced failure and source fix

Start-VerifiedOriginalRelayChild previously used Process.Start, WaitForExit and
Dispose. Disposing a process handle does not contain the child tree. A forced
supervisor exit bypasses finally, and normal launcher exit can leave a descendant.

The new real-process regression creates an isolated supervisor, launcher,
descendant and unrelated control. Before implementation, both supervisor-stop
and launcher-exit cases failed with "left owned launcher/descendant alive after
supervisor lifetime ended" on Windows PowerShell 5.1 and PowerShell 7.

The replacement gives each newly created child tree an unnamed, non-inheritable
Windows Job Object with KILL_ON_JOB_CLOSE. PROC_THREAD_ATTRIBUTE_JOB_LIST assigns
membership as part of CreateProcess, before child execution. There is no
start-then-assign race, existing-process adoption, or uncontained fallback.
Closing the sole job handle on launcher exit or supervisor death removes only
that newly owned tree. Raw protected action arguments, working directory,
process environment, child exit status and the existing retry policy remain intact.

Requires Windows 10 / Server 2016 or newer. Native job/attribute/creation failure
fails closed; compatibility with the actual scheduled-task parent job must still
be rehearsed safely before installation.

References:
[atomic job assignment](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812/),
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

## Verification evidence

- Strict RED observed for both lifetime failures in both PowerShell hosts.
- GREEN: both real lifetime cases on both hosts; unrelated control preserved.
- All 19 relay contracts on both hosts passed (38 runs).
- Additional native-launch contract passed on both hosts: literal quoted argv,
  real working directory, inherited synthetic environment, exit 37, native
  creation failure without fallback, redacted error.
- Independent reviewer separately ran lifetime and native-launch tests on both
  hosts. No Critical or Important production finding. Minor test limitation:
  an early fixture identity/readiness failure can leave synthetic descendants
  alive until their bounded 60-second lifetime when containment itself regresses.
- pnpm -r build and pnpm -r typecheck passed.
- Initial pnpm test failed the unmodified browser test:
  B6 CDP operational path proves native upload download diagnostics checkpoint
  and conflict; operations-integration.test.ts:173 timed out awaiting download.
- Initial cargo test --workspace could not find x86_64-w64-mingw32-clang.
  Existing LLVM installation found; retry uses a process-local PATH only.
- Full no-bail workspace and Rust rerun results are recorded below after completion.
- GitHub CLI authentication is invalid (HTTP 401); no remote CI success is claimed.

Local detailed logs: sibling directory Tetherplane-orphan-evidence-20261013.
A green isolated test is not a live recovery, cold-boot or automatic-restart proof.

## Guarded continuation: all gates required before interrupting the live relay

1. Review and pin the exact source commit. Require full Windows/Ubuntu CI and
   both PowerShell contracts at that commit. Preserve failing-test evidence.
2. Preserve original protected stage, task XML, manifest, pre-bridge checkpoint
   and failed-bridge archives. Do not overwrite any of them to bypass a guard.
3. Prepare and independently review a dedicated legacy-orphan handover and rollback
   procedure. The existing -Apply/-Rollback scripts deliberately reject a Ready
   task with an occupied port; do not relax that rejection or invoke them blindly.
   The lifetime patch only protects future child launches; it cannot adopt the
   current orphan into its new job.
4. That procedure must revalidate exact PID plus creation time, trusted executable
   and complete command identity, owner SID, exclusive listener, historical task
   provenance, unchanged task XML, effective ACLs/digests, and auth identity
   immediately before any action. Missing or conflicting evidence is a stop.
5. Rehearse task/job compatibility and recovery in an independently owned test
   task on a separate vacant loopback port. No production endpoint, production
   token or unrelated service may be used by the rehearsal.
6. Require a bounded, explicitly approved interruption with a tested rollback
   path. Use only identity-bound handles for the proven legacy tree, never
   names, stale PIDs, wildcard termination, or taskkill /T on ambiguous ancestry.
   Prove port vacancy and exact task registration before one supervised start.
7. Accept restoration only with a fresh independent preflight reporting
   SUPERVISED_AUTH0_VERIFIED, new verified process ancestry/creation times,
   unchanged auth identity/issuer/JWKS/private routes, public readiness, and
   authenticated existing-client continuity. A healthy HTTP endpoint is insufficient.
8. On failure, preserve evidence and report recovery/rollback UNVERIFIED.
   Never kill an unknown listener or repeatedly restart in order to force a pass.
   Bridge activation, Auth0 cutover, crash injection and reboot remain separate.

Current decision: **NO-GO for live interruption**. The current relay remains
healthy but unsupervised. The reviewed source fix is preparation, not a completed
legacy-orphan handover procedure.
