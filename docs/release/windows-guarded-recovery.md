# Guarded Windows agent recovery — source-only draft

**Status (2026-10-23):** Engineering candidate. No protected-device deployment, task trigger change, reboot, agent termination, registration, OAuth operation, signer provision, or release. Stacked on the reliability work in PR #44, not on the signed Windows kit in PR #46.

## Evidence and problem

On Leno, `Tetherplane Leno Canary` is the single approved native agent task. It owns one `tetherd.exe`, has an interactive logon trigger, `MultipleInstances=IgnoreNew`, and a three-attempt one-minute `RestartOnFailure` setting. The old agent tasks and V2 standby are disabled.

A disposable Task Scheduler action that exited with code 23 was **not retried** in 94 seconds. A second disposable action, deliberately killed after exact PID verification, was **not retried** in 98 seconds. Both executions were logged as completed. A separate periodic trigger (without `RestartCount`) **did** run twice, 61.8 seconds apart, despite the first action exiting 23. Each test cleaned up only its own synthetic tasks and directories. No `tetherd.exe` was killed.

This supports *periodic re-evaluation* as a recovery approach. It does not prove auto-restart of a real device, permission to start a higher-privilege task from a Limited task, offline hardware restart, or service-level health detection. A running but unresponsive agent is **not** automatically killed or replayed.

## Minimal integration

`scripts/windows-agent-recovery-guard.ps1` inspects the **existing approved native task**. It does not create or migrate an agent task. It never handles raw credentials, creates a new device identity, changes OAuth/scope config, terminates processes, downloads binaries or disables other tasks.

For every check, require all of these independently pinned inputs: existing task name; approved agent SHA-256; installed local argument-file SHA-256; approved principal-profile SHA-256; device ID; relay WSS URL; the reviewed task RunLevel (`Highest` or `Limited`). The guard also checks current user SID vs task principal, action `tetherd.exe --arguments-file`, path-redirection ancestors, local credential/profile/state presence, exact device and URL inside the JSON argument file, single-instance setting, and **all** other enabled native Tetherplane agent tasks.

Decision policy:

| Observed condition | Result |
| --- | --- |
| One approved executable, task Running | `healthy`, no new launch |
| One process with hidden executable path, task Running | `present_unverified`, no new launch; **never claim ownership** |
| Exactly zero `tetherd.exe`, approved task Ready | `would_start` (default read-only); only with explicit `-StartIfMissing` may it request the original task once |
| One process with task Ready (possible orphan) | Deny |
| Other enabled agent task, different executable, >1 process, missing or changed approved file, unexpected principal or task state | Deny |
| Agent started locally | `started_local` only after a post-start process check; **not** proof of authenticated relay acceptance |
| Agent launch uncertain | Deny repeated attempts within that invocation; leave existing state for inspection |

`IgnoreNew` is **per Scheduled Task**, not a cross-task or operating-system-wide process mutex. Two independent launchers racing can still be unsafe. This guard performs preflight plus a second immediate pre-start check; it is not claimed to be a global atomic singleton lock.

## Validation performed

- Leno: checked out-of-tree isolated source by the exact Git blob SHA-1 before any execution. PowerShell 5.1 AST parsing succeeded.
- Leno: 15/15 initial and 18/18 expanded Pester 3.4 tests passed, with no skipped tests. Denial includes orphan, second native task, duplicate agent count, foreign owner, changed argument bytes, and a protected/higher-integrity process whose path is unavailable.
- Leno: the guard returned `healthy` from a read-only direct call when run with sufficient observation rights. A disposable **Limited** Scheduled Task could not inspect the elevated agent path; updated guard returns `present_unverified` and does not attempt a second launch. The temporary test task and files were removed.
- Previous isolated periodic-trigger test: two launches 61.8 seconds apart and completed cleanup.
- Existing agent PID was preserved throughout. No production task or trigger was changed by this recovery-guard PR work.

## Deployment gate — NOT approved by this document

After code review, passing Windows CI, independent recovery access, checkpointed task configuration, and owner approval:

1. Confirm the exact authorized task, binary hash, arguments file hash, principal hash, task SID, sole process and current authenticated MCP status. Record immutable evidence without storing credential contents.
2. Stage the reviewed and appropriately signed guard from a trusted distribution, with approved file ownership and ACLs. Pin the guard script SHA-256. Never run a mutable `Temp` script as a permanent startup action.
3. Independently verify a **Limited** guard Scheduled Task can request the existing native task in a disposable, privilege-matched fixture, with no new device identity or security policy change.
4. Register one dedicated guard task with `MultipleInstances=IgnoreNew`, user interactive logon ownership, a bounded five-minute periodic trigger and explicit script/identity pins. Do not alter the native agent task action or create another native agent task. Record the original task configuration before changes.
5. First test only repeated guard `present_unverified` responses with the real agent alive. Prove no duplicate process, and verify task cleanup/rollback. A limited user may not see the higher-integrity process path: this is not a failure of the no-op guard.
6. Perform a **controlled** one-agent stop/restart canary only after an independently verified recovery path or approved local operator/rollback. Measure time to authenticated status, exactly one authorized PID, correct denial in negative controls, and whether the task remains recoverable. Never replay uncertain MCP mutations.
7. Acknowledge separate signing, clean-install, Smart App Control, pairing approval, rollback, real logon and four-device release gates before promotion.

## Known limitations

- With `-StartIfMissing`, a local check may race with independently launched processes; no kernel-wide singleton exists in the currently installed binary.
- A Scheduled Task may run at higher integrity than a Limited guard. Visibility and **actual start permission in absence of a running task** require independent tests before deployment.
- Task Scheduler's enabled/restart settings are not evidence of delivery. Neither remote authentication nor process health can be inferred from a live PID alone.
- Current source is unsigned; the approved public Authenticode identity does not exist. This is not a Windows installer or distributable release.
- The guard deliberately does not cure a live-but-unresponsive agent. That is a separate bounded-liveness/controlled-rollover problem.

**Release decision: NO-GO.** Do not merge, sign, publish or deploy this branch to personal devices without the remaining gates.
