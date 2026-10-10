# Vaulter relay controlled crash-recovery rehearsal

**Date:** 2026-10-10
**Scope:** Task-owned relay on Vaulter only. Does not change OAuth issuer, Tailscale routing, protected credential files, task definition or other devices.
**State:** Source-side guarded rehearsal; completion requires fresh on-Vaulter evidence.

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
