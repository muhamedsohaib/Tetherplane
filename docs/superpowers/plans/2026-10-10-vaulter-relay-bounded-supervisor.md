# Vaulter bounded Auth0 relay supervision and guarded handover

**Date:** 2026-10-10
**Status:** Source implementation. Live Vaulter supervisor activation and automatic-recovery acceptance are still pending. CI alone does not prove live recovery.
**Target:** The existing Interactive Windows Scheduled Task named Tetherplane Relay on Vaulter. GitHub and Leno remain canonical. Do not use Remote Desktop Commander against Vaulter.

## Verified failure and recovery evidence

- Two controlled task-owned Node crash exercises did not automatically restart the relay. The guarded manual task restart recovered it both times.
- At 2026-10-10 13:07:01 Vaulter time, TaskScheduler/Operational Event 201 recorded launcher exit 0xFFFFFFFF; Event 102 completed that task instance. The registered restart policy was Count=10, Interval=PT1M.
- No automatic replacement appeared within 180 seconds. At 13:10:08 events 325/110/200/100/129 belonged to the authorized manual restart.
- After manual recovery, result 0x00041301 means the task is running. It does not prove automatic recovery.
- Independent postcheck passed relay and self-hosted auth health, Auth0 issuer, JWKS-only canary and all four private ports 10000, 8443, 9443 and 9445.
- The precise reason Task Scheduler did not retry remains unconfirmed. The additional supervisor addresses the observed failure mode without changing identity or Funnel configuration.

## Architecture

The new source-managed scripts are:
- scripts/vaulter-relay-bounded-supervisor.ps1
- scripts/vaulter-relay-supervisor-handover.ps1
- scripts/vaulter-relay-supervised-rehearsal.ps1

The bounded supervisor is read-only by default. Only its protected installed copy may run in Serve mode, and only as the registered task action. It verifies the exact original PowerShell task action, its working directory, the trusted original launcher SHA256, protected rollback checkpoint and task ownership. It never reads the bridge token, changes Auth0 or reconfigures Tailscale.

The supervisor launches the unchanged original task action as a blocking child process. Unexpected exits, including exit code zero, initiate a bounded replacement only when the port is vacant and the original named task remains owned and active. It uses exponential delays of 2, 4, 8, 16, 30, 30 seconds with six retries per failure streak; a child running 300 seconds resets that streak. The existing IgnoreNew setting and a global cross-session mutex prohibit overlapping supervisors. An intentional stopped task does not initiate a replacement. No human-owned process is terminated.

The handover script has separate modes:
1. Default: read-only preflight, including protected backup consistency and original Auth0 health.
2. Stage: create a NEW private relay-supervisor folder with inherited-then-protected ACLs, copy reviewed source verified against its expected SHA256, store the exact current corrected task XML and hashes. It does not stop or modify the relay, and refuses an existing stage.
3. Apply: demand current original task XML match the private snapshot, stop only the named task, require Ready and no 8788 listener, update only its action, start once, prove unchanged settings and local/public Auth0 health plus Node -> original PowerShell -> installed supervisor process ownership. Any failure attempts a scoped, independently verified original-action rollback.
4. Rollback: restore the exact original task action using proven supervisor ownership or an empty port, then verify the original Auth0 relay. A failed rollback must report ROLLBACK UNVERIFIED.

The supervised rehearsal defaults to read-only. Exercise kills only the revalidated owned Node child. A pass requires a NEW healthy Node and launcher under the SAME supervisor PID and creation time, unchanged task XML and authorization PID, and healthy Auth0 and independent postcheck within 120 seconds. Failure attempts the original task rollback and still reports automatic recovery unverified. It never labels manual recovery as an automatic pass.

## Execution gates

1. Strict RED/GREEN tests on Windows PowerShell 5.1 and 7: true isolated child failure and relaunch, bounded backoff, stable-run reset, task ownership, original action/working-directory preservation, protected stage, action-only registration, rollback and newly supervised recovery negative cases.
2. Full repository Linux and Windows CI passed on the exact proposed source commit.
3. Fresh operator-controlled elevated PowerShell on Vaulter verifies the pinned GitHub SHA, clean worktree, configured remote, protected folder and original launcher hash, read-only supervisor/handover preflight, independent postcheck and current task state. No secrets or task command lines may be printed.
4. Stage verified source and backup without stopping the running task. Compare original relay PID and independent health before proceeding.
5. Apply only during an approved maintenance window with a human supervising rollback; never combine this with bridge activation or issuer cutover.
6. Independently run postcheck and supervised rehearsal read-only preflight after activation.
7. Only after the prior gates, authorize ONE supervised Exercise; preserve the Task Scheduler event timeline. Require same-supervisor automatic verdict AND independent postcheck. If recovered by rollback, automatic recovery gate is still blocked.
8. Review reboot/logon recovery separately; the existing Interactive logon task does not establish unattended restart after boot.

## Next: bridge and authenticated OAuth acceptance

The existing guarded native bridge launcher is source-managed but has NOT been integrated under this supervisor. Replacing the task action directly with that unsupervised launcher would discard the reliability improvement. First design and TDD-test a supervised bridge-enabled child strategy with exact Node flags, process-only bridge token inheritance, unchanged Auth0 OIDC bindings, exact paired device registry, local policy checks and protected rollback. Retain the public root and four tailnet-only ports. Prove device-assisted approval, Auth0-authenticated six MCP tools, Leno device routing and a local policy denial before considering bridge staging accepted.

Self-hosted tether-auth OAuth cutover requires separate verification of browser-facing interaction/login/consent UX, authorization code + PKCE S256, discovery, JWKS, registration, refresh, revocation, reconnect and authenticated ChatGPT six-tool tool-list acceptance. Auth0 remains active until these independently pass. Health or public JWKS alone cannot substitute for that acceptance.

**Stop:** Unknown task/process owner, port conflict, unexpected task XML drift, source/hash/ACL mismatch, failed CI, missing backup, changed auth PID or Funnel routes, incomplete rollback, or a failed fault exercise. Do not repeat the crash or reboot before diagnosing the result.
