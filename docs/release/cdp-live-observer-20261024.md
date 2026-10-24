# Windows scoped-observer live acceptance — 24 October 2026

**Decision: development evidence only; PRODUCTION NO-GO.** Draft PR #55 is stacked on draft PR #54 (`998765c46b45593c211dad4b3905809346b64a08`), itself stacked on #53/#52/#50/#49. No protected branch merge, signing, device installation, OAuth/DCR or owner-grant changes occurred.

## Goal and scope

Prove that the process evidence primitives introduced in PR #54 operate correctly against a **real hosted Windows process snapshot**, not just synthetic `PSCustomObject` fixtures. A single owned Node process intentionally holds for eight seconds. The observer samples Windows CIM process metadata, binds the spawned PID to its actual process creation timestamp before accepting aggregates, and writes only bounded process counts, memory, CPU, I/O, time and status. No paths, process IDs, command lines, raw exceptions, bearer tokens, human browser tabs or live device processes are exposed.

The ephemeral worker does not fork or access network/files. Test setup, observation, process cleanup and result receipt are within one guarded scope. `Test-WorkloadOutcome` requires a fresh GUID, exact GitHub checkout SHA, at least two valid samples, no observer errors, bounded completion and known owned-root termination. A failure remains a failed CI job with a retained sanitized receipt.

## Failing-first findings and corrections

1. **Host PowerShell syntax:** First hosted focused attempt at `e92dc747`, run [40076928067](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40076928067), failed to parse numeric literals containing underscore separators. Fixed without changing product deadlines.
2. **Real Windows snapshot versus synthetic fixture:** The hosted observer returned `STAGE=observer;SAMPLES=0;ROOT_VERIFIED=False`. The module rejected all process snapshots containing Windows system-idle PID 0, even though PID 0 is unrelated to the positive owned root. The new synthetic regression at `40c9bb0974d46f2e7100c0058aab9dd1ac2e1c62` failed intentionally in [run 40077062544](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40077062544), proving RED. Fix `791d37686a15fc24d129881d2d3f7be897271871` excludes **only** pseudo PID 0 while retaining rejection of negative/duplicate IDs and positive-root creation-time validation. Its focused Windows push/PR contracts passed.
3. **Isolated process subtree:** After the PID 0 correction, live Windows sampling validated the root but reported an additional descendant (`STAGE=observer_scope;SCOPE_SINGLE=False`). The hosted CI worker's separate console-creation mode could introduce an OS-managed descendant. The exact process type was **not logged or independently proven**. The fixture now reuses the existing isolated CI console; it does not weaken process-scoping logic or claim those child processes never existed.
4. **Safe error reporting:** Failed runs exposed only fixed error stage, sample count and a boolean identity/scope state. Raw Windows diagnostics, user paths, process IDs and command lines were not emitted.

At source commit `1c50620abde9d0a72592828de7045a971c247d54`, the dedicated live observer completed successfully in both [push run 40077176643](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40077176643) and [PR run 40077179061](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40077179061). The hosted push log explicitly recorded `CDP_LIVE_SCOPE_VERIFIED=PASS;SAMPLES=12`. The scoped evidence contract also passed in push and PR at `1c50620a`. Separate Windows/Ubuntu full-quality workflows at that source were still running when this note was authored; verify their exact conclusions independently.

## What remains unproven

This is a **non-forking disposable Node fixture**, not Chromium startup under the complete parallel test workload. It does not isolate the intermittent pre-`DevToolsActivePort` 12-second stall or the separate post-readiness CDP command-response timeout. No Chromium timeout, test deadline, retry or product serialization changed. The six findings from the interrupted Work independent review remain incompletely recovered; do not substitute this result for that review.

Before integrating this observer with the broad workload, establish lifetime-bound owned descendant tracking and explicit cleanup checks for all observed children; a single terminated wrapper is insufficient proof of process-tree cleanup. Compare observer-on/off and cold/warm launches with identical workload and immutable evidence. Missing counters must remain unknown, never zero. Keep failures fatal and distinguish observer overhead from product behavior.

Current release gates remain Leno's existing tailnet-offline/`NoState` state before relay authentication, VAULTER authenticated Control Center/original UI acceptance, RTX first installation, owner-grant allow/deny/revocation across four devices, trusted-signature distribution, clean install and verified rollback. No live devices, authentication boundaries, identities, grants or installed agents were modified.
