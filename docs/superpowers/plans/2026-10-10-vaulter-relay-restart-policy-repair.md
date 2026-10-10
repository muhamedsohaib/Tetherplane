# Vaulter relay retry count — guarded repair

**Date:** 2026-10-10
**State:** Source-only candidate. No live Windows Scheduled Task settings have been changed.

## Operator evidence

Read-only Vaulter inspection of the current registered task named Tetherplane Relay returned:

- State: Running; enabled; exactly one loopback relay listener.
- Principal logon type: Interactive.
- Trigger: LogonTrigger (not a boot trigger).
- RestartCount: 999, RestartInterval: PT1M.
- StartWhenAvailable: true, MultipleInstances: IgnoreNew, ExecutionTimeLimit: PT0S.
- Task LastTaskResult: 267009 (0x41301, task running).

Microsoft Task Scheduler schema defines RestartOnFailure/Count as an unsigned byte with valid values 1 through 255. The registered 999 is outside that schema. This alone does **not** prove restart failure. A logon-only trigger does **not** establish startup before sign-in.

## Source change

Use the independent repository script scripts/vaulter-relay-restart-settings-repair.ps1, tested by tests/release/vaulter-relay-restart-settings-contract.ps1.

- Default is read-only. It requires current Vaulter identity, a protected local rollback directory, the original Interactive relay task, healthy Auth0-backed MCP metadata, the pinned original launcher hash, exactly one loopback port-8788 listener and expected PowerShell parent/Node child.
- The task action and registered XML are read but never printed; protected bridge credentials are not read.
- A separate explicit -Apply is limited to changing RestartCount from 999 to 10 using the existing settings object. The PT1M interval, principal, logon trigger, task action, existing node process and all other XML are checked for equivalence. A private backup of the original task XML is written before applying.
- On error while the original count was 999, **never attempt to restore the invalid count through Task Scheduler**. Only verify unchanged original XML and running process; if it differs, stop and report rollback unavailable for operator-led recovery. A protected backup is reference evidence, not proof of a restorable running task.
- Automatic restart after a crash and unattended boot startup are **not** proven by a successful settings correction. A separate, approved recovery test is required.

## Read-only acceptance before live apply

At the exact pinned Git SHA, require passing full Rust/TypeScript CI and PowerShell 5.1/7 contract checks. On Vaulter, run this standalone script in default (no -Apply) mode and record only its sanitized verdict. Confirm original task and process identity remain unchanged, and compare local/public Auth0 relay health/JWKS, existing six MCP tools and four tailnet-only Tailscale ports against their preserved baseline.

If defaults differ, do not patch unknown task state automatically.

## Deployment ordering

1. Correct the invalid restart count only after approval of this narrow settings change; never combine it with bridge activation, task action rewriting, issuer cutover or Funnel changes.
2. Verify that the current relay PID, parent creation times, task XML (except the count), port listeners and live Auth0-backed MCP remain unchanged.
3. Independently perform a controlled and reversible crash/recovery rehearsal under a separate maintenance authorization. Do not claim automatic restart based solely on Task Scheduler configuration.
4. Only after crash recovery is proven can the separately tested bridge-launcher task handover be considered.
5. Defer any shift from Interactive/LogonTrigger to a boot/S4U or service principal as another separately tested design change.

**Stop conditions:** failing checks, altered process ownership or creation time, unauthorized task XML delta, missing protected backup, changed bridge/auth credentials, changed public routes or unverified rollback.

References: docs/superpowers/plans/2026-10-10-vaulter-relay-bridge-activation.md; Microsoft Task Scheduler Count restartType schema; existing tested auth restart settings repair contract.
