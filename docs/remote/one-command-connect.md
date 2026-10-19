# One-command Tetherplane onboarding

## Existing device recovery (available today on the local machine)

On Leno, the existing dedicated task can be requested with:

```powershell
Start-ScheduledTask -TaskName "Tetherplane Leno Agent"
```

This is **only a start request**. It does not assert the Windows app-control policy permits the agent, that the device WebSocket is connected, or that the authenticated ChatGPT account can route to it. Verify with the connected Tetherplane MCP tool: `device(op="status", device="Leno")`. Do not disable Smart App Control, replace credentials, or rename tasks to work around a failure.

This branch introduces `scripts/connect-windows-device.ps1` to reject unexpected task owners/actions and produce an explicit unverified status. It is an existing-task recovery helper, **not an installer**.

## Planned memorable installer/connector

Proposed **unpublished** command:

```powershell
npx @tetherplane/cli@latest connect
```

Do not advertise this as usable until package ownership, publication, signed artifact provenance, and an end-to-end Windows install/pair/reconnect/reboot gate are verified. Node/npm would be needed for the npx bootstrap, but the installed agent remains native and does not require a running Node process. The intended published command must:

1. Download a reviewed release by pinned provenance, validate signatures and source, and reject unsigned or mismatched artifacts under a public-trust policy.
2. Discover whether the machine has a local install without taking ownership of foreign paths/tasks, and preserve the original device ID, principal, credential and grants.
3. Establish outbound transport through the existing supported relay under an individual device credential; never copy a credential from another computer.
4. On first pairing, display a short-lived code for the signed-in account to approve and resume once approval is verified. Do not self-approve.
5. Start only an owned background agent task and independently query the authenticated MCP device status; distinguish task running, relay connected and account verified.
6. Provide a scoped `doctor` command and a non-destructive recovery procedure; preserve Smart App Control and Defender.

Current private Windows onboarding requires the approved ZIP plus hash, pairing approval, and finalize step. A single remote MCP connection belongs to the account; each controlled computer needs its own agent instance and locally generated credential. The device transport currently requires the Vaulter tailnet; a public end-user installer requires an explicitly reviewed relay/discovery topology. No instant connection without trusted installation and account approval is promised.

## Leno-specific stop conditions

Earlier Leno verification reported a Code Integrity 3077 denial of an unsigned agent and a stopped dedicated task. A restart request cannot override that policy. If the task remains ready/offline or Windows reports application-control denial, stop; secure a genuinely trusted signed candidate, verify legacy receipt/task ownership, then perform a controlled local replacement. Do not modify Windows security settings.
