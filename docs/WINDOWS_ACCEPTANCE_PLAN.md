# Windows Acceptance Plan

A GitHub Codespace (Linux) **cannot** certify Windows desktop, lock, sleep/wake, or interactive-session behavior. Zero live Windows evidence exists today; nothing in the Linux fault lab substitutes for this plan.

## Gate

Operator-present run on the Windows machine (Leno) via `scripts/live-acceptance.mjs --prepare / --live --user-present / --cleanup`, requiring clean `main == origin/main` and an isolated `%LOCALAPPDATA%` install. Markers `LOCAL_LIVE_ACCEPTANCE` / `RELEASE_TAG_ALLOWED` only after observed stages. Unsigned publication stays blocked.

## Existing stages

Source, package, install, six-tool smoke, local core, browser semantic, desktop semantic, remote plane (`device.status` observed locally + remotely).

## Stages to add before any unattended-readiness claim

1. **Locked workstation.** Lock Windows; verify: device/files/process/job operations still succeed; already-connected browser semantic ops behave as observed (record actual result); desktop snapshot/act return the *observed* truthful state (expected: fail closed, never fake success); physical pointer ops denied without lease.
2. **Unlock + recovery.** Unlock; desktop capability returns to `ready` only after a live UIA probe; stale references fail `stale_reference`, never target the lock screen or another window.
3. **Sleep/wake cycle.** Sleep ≥2 min (past foreground-lease TTL), wake; verify leases expired, handles invalid, relay reconnect on a new generation ≤30s after network return, no replayed mutation.
4. **Reboot + logon.** Restart OS; agent offline before logon (AtLogOn start — record as a stated limitation), auto-start at logon, durable jobs/idempotency intact, fresh authorized op succeeds with no manual step.
5. **Browser runtime onboarding.** Fresh install with no Chromium present must report browser `disconnected`/not-installed truthfully (not "installed successfully"); after installing Chromium + extension pairing, browser reaches `ready` only on a real `pages` probe.
6. **Resource baseline on Windows.** Working-set idle + cold start via `scripts/bench-local.ps1`; record beside the Linux floor; investigate variance before claiming the <250 ms target.

## Explicitly impossible / limited on Windows

- No agent before logon or after logoff with the current AtLogOn (Limited) registration; a boot-time service is a separate, owner-approved design change.
- Secure-desktop (lock/UAC) surfaces are not automatable by design; operations needing the interactive session must wait for unlock and say so.
- Per-hardware sleep/wake certification is out of scope (threat model); certify the tested machine only.

Record per stage: initial state, injected fault, observed transition, recovery seconds, final state, independently verified outcome (file bytes / counters / operator observation).
