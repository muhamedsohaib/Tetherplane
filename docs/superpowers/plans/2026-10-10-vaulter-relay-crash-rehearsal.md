# Vaulter relay controlled crash-recovery rehearsal

**Date:** 2026-10-10
**Scope:** Task-owned relay on Vaulter only. Does not change OAuth issuer, Tailscale routing, protected credential files, task definition or other devices.
**State:** Live Vaulter crash rehearsal performed 2026-10-10: **manual-only recovery verified; automatic recovery failed verification**. Auth0 and Funnel preserved. Root cause pending read-only scheduler-event forensics; do not repeat fault injection or activate bridge.

## Live rehearsal result — 2026-10-10

- Exact source revision: `f01590771cd7a344c5175b47f5e2b0227aad7250`; focused Vaulter contracts and full Linux/Windows CI passed at that revision.
- Independent precheck reported S4U auth supervised/healthy at PID 7752, original Auth0 resource metadata and public signing verification keys, Funnel root and /jwks routes, and four tailnet-only ports.
- Guarded relay fault injection ran once. Script observed no healthy, independently attributable replacement during the bounded 180-second automatic-recovery window.
- The script's guarded named-task manual start restored the relay; independent postcheck then passed without changing the issuer, public JWKS or private routes.
- **Interpretation:** `manual_only` means automatic restart is unverified/failed the acceptance gate; it does **not** prove the scheduler never attempted a restart, or identify the cause.
- Before any additional live perturbation, run only read-only `scripts/vaulter-relay-restart-forensics.ps1` against Vaulter TaskScheduler/Operational events, which redacts action arguments, event descriptions, identities and secrets. Correlate Event IDs and action ResultCode across the rehearsal interval. If history is unavailable, instrument a separately reviewed rehearsal before any second injection.
- Candidate causes to investigate, **not claims**: action exit not recognized as failure; Task Scheduler did not retry; a retry was attempted but failed; or the current running task instance had not adopted the registered settings-only correction.
- **Stop:** No second forced child kill, task definition change, launcher replacement, bridge activation or OAuth migration until root cause is supported by evidence and a scoped repair is tested.

## Baseline verified by operator

- Windows Scheduled Task: Tetherplane Relay, Running, enabled, Interactive principal and one LogonTrigger.
- Restart policy was corrected in place from out-of-schema 999 to 10, retaining PT1M and the original task action, principal and triggers; protected task XML backup created. Independent postcheck confirmed relay PID 8096 still listening on 127.0.0.1:8788, auth 127.0.0.1:8790 healthy, and Auth0 issuer retained. PID 8096 is historical evidence, never a future crash target.
- Original launcher hash 5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8 was verified and its single exit directly propagates the native child LASTEXITCODE. This is not proof of Windows Task Scheduler automatic recovery.
- Protected original-relay checkpoint under Tetherplane/tether-auth contains launcher.ps1, auth-config.json, device-state.json and relay-task.xml. Verify the checkpoint's protected directory and original launcher hash before any injection.
- Public health and MCP protected-resource metadata still originate at https://vaulter.tailf65eba.ts.net, protected resource authentication remains Auth0, and self-hosted auth port 8790 remains privately supervised.

## Rehearsal script and safety

scripts/vaulter-relay-crash-rehearsal.ps1 is read-only by default. Its initial preflight insists on the exact original launcher hash, a registered retry policy of 10/PT1M, the Interactive task, one task-owned Node child with a PowerShell parent, original task XML, protected rollback checkpoint, loopback relay + auth ports, and local/public Auth0-protected resource health.

The explicit -Exercise flag triggers one and only one fault injection, targeting the *currently revalidated* original relay Node process using its PID and creation time. It never terminates processes by name and never re-registers or disables tasks, reads credentials or changes Funnel routes.

The script distinguishes:
- automatic: replacement Node process and PowerShell task parent have new PID and creation time, registered task XML is unchanged, existing self-hosted auth PID unchanged, local and public Auth0 relay probes are healthy, all without manual task intervention.
- manual_only: automatic recovery was not established. After verifying no listener and unchanged task definition, a single manual stop/start of only the named relay scheduled task restored health. Automatic recovery remains a blocker.
- RECOVERY UNVERIFIED: neither automatic nor safe manual recovery can be established. Do not repeat fault injection, reboot, or change the OAuth provider; inspect only the named task, listener, protected checkpoint and restart settings for recovery.

The script is not an always-on daemon and makes no runtime configuration change. An unattended-reboot guarantee is out of scope because the task is logon-triggered/Interactive.

## Required evidence after running on Vaulter

Report only the sanitized one-line outcome from the rehearsal. Verify separately that local and public relay health are OK, the protected-resource metadata still advertises https://tetherplane-dev.eu.auth0.com/, auth port 8790 remains healthy, and exactly one loopback listener on port 8788 belongs to the replacement task-owned Node child. Validate anonymous MCP initialize/tool discovery exposes exactly six tools; authenticated device status and local policy denial are separate gates.

A manual-only or unverified recovery result blocks the subsequent bridge handover. If automatic recovery succeeds, the next stage is a separate verified task action handover to the native Node bridge launcher with exact --auth-config and --state-file arguments. Tailscale Funnel and self-hosted issuer cutover remain separate.

## Operational restrictions

- No use of Remote Desktop Commander on Vaulter; Leno is the only permitted target for that tool.
- Never print task action arguments, private auth state, access tokens, private JWKS, process command lines or environment variables.
- Do not modify /auth/device-login routing, public /mcp or four private Tailscale ports during rehearsal.
- Do not claim success from the PowerShell exit alone; require externally verified process, task, local and public health evidence.
