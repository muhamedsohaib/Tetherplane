# Four-Device Mesh Rollout: RTX / Vaulter / Surface / Leno

Date: 2026-10-11
Status: APPROVED SCOPE; source-only preparation. No new live-device execution verified.
Base: `bb99812602de81eed281b5b580deebf04e2ffaa9`
Canonical repo: https://github.com/muhamedsohaib/Tetherplane

## Goal

Reach four individually authenticated Windows devices through one Tetherplane Compact MCP endpoint (exactly `device`, `files`, `process`, `browser`, `desktop`, `batch`) without Remote Desktop Commander hosted call quotas. Preserve local Policy Broker authority, user focus/clipboard/tab ownership and existing Auth0 identity bindings.

## Topology and roles

ChatGPT/Codex -> existing Auth0-protected public HTTPS MCP endpoint on Vaulter -> existing relay -> four outbound authenticated `tetherd` WebSocket connections. Optional same-tailnet Tailscale overlay is the private management underlay; remote agent connections remain outbound-only and do not require inbound control ports.

| Device | Logical ID | Role | Safe default |
| --- | --- | --- | --- |
| Leno | `Leno` | canonical development repo and acceptance anchor | background-only, scoped source roots |
| Vaulter | `Vaulter` | existing relay, Auth0, private registry and local agent | preserve public origin/issuer and private ports; no relay duplicate |
| RTX | `RTX` | model/GPU job execution when policy permits | Tetherplane-owned job/process scope only |
| Surface | `Surface` | interactive productivity/browser workflows | never touch human-owned foreground resources without scoped lease |

Machine identity must be checked on-device. Do not infer RTX/Surface mapping from unrelated Remote Desktop Commander display aliases.

## Entry blockers and rules

- Current live Vaulter evidence: original Auth0 scheduled-task action and XML restored, task Ready; existing relay PID 3776 on loopback 8788 healthy, auth PID 5652 on 8790 healthy; original bounded supervisor PID 1256 absent, and the current relay ancestry was not verified to have a living grandparent. **Supervision is NOT restored.**
- Live bridge activation returned `BRIDGE HANDOVER ROLLBACK UNVERIFIED`. DO NOT re-run `-Apply`, arbitrary `-Rollback`, terminate PID 3776, reboot Vaulter or overwrite the protected stage without first proving ownership and a controlled recovery path.
- Remote Desktop Commander hosted credits currently zero; agent status/ping do not authorize command execution. Do not assume its availability on any of the four machines.
- The existing per-user Windows installer registers the `Tetherplane Agent` task only with explicit `-InstallScheduledTask`, and uses an `AtLogOn` trigger. No pre-login reboot-resilience claim until independently demonstrated or a separately reviewed persistence change is installed.
- Do not publish a `v0.1.0` release tag: `docs/live-acceptance.md` requires operator-observed Leno and authenticated remote acceptance first.
- Zero external credentials or raw device tokens in logs, GitHub, remote terminal output, task arguments or copied machine configs; each device generates its own credential locally and pairs to the existing account with human-approved code.

## Parallel critical path

### Track A: Stabilize Vaulter without losing the live relay

- [ ] Obtain an authorized live executor independent of the exhausted hosted RDC quota. Prefer a previously authorized Tetherplane/local management channel, or one-time local operator presence. Do not create a secret-bearing emergency tunnel.
- [ ] Read-only verify port 8788 process tree and creation-time continuity; scheduled-task action/XML; protected stage ACL and SHA-256; auth 8790; public readiness and issuer.
- [ ] Reproduce and fix the bounded supervisor stop/child-lifetime handover failure with failing tests FIRST. Record the root cause; do not treat current healthy endpoints as verified supervision.
- [ ] Prepare a guarded recovery that preserves the existing relay until a bounded, ownership-verified handover can occur. Require no port conflict, task registration matching the original snapshot and independent postcheck; preserve rollback artifacts. Require explicit visible approval for any planned service interruption.
- [ ] Independently prove the original supervised fallback is active, with task running, relay descendant of approved supervisor, auth stable and existing client connectivity preserved.
- [ ] Only after stable fallback, revisit protected bridge activation using a new reviewed test and fresh Windows+Ubuntu CI. Failure must leave verified original supervision, not orphan a relay process.

### Track B: Prepare one four-device installer artifact without touching live services

- [ ] Pin an exact reviewed source SHA; package Windows x64 `tetherd`, Compact MCP and runtime assets ONCE using `scripts/package-windows.ps1`; verify the package manifest and SHA-256. Use a feature-branch prerelease/test artifact, NOT a premature public `v0.1.0` tag.
- [ ] TDD a safe one-click/bootstrap entrypoint that calls the existing `scripts/install-windows.ps1` per user. It must refuse occupied install locations without a reviewed migration and never invoke `-Force` automatically.
- [ ] During local enrollment, create a unique high-entropy credential protected on that device, POST only its hash to the trusted relay pairing endpoint, and require human-approved short code; never print or export the raw credential.
- [ ] Create separate device-scoped policy/allow roots and durable state. Use `background_only` initially, no foreground lease or human-owned process/window/tab actions.
- [ ] Persist the agent via existing `AtLogOn` task for the immediate first-pass mesh; separately design/test least-privilege unattended-startup persistence for reboot/sign-out before claiming full always-on status.
- [ ] Bundle a local verification that reports only: expected source hash, stage and policy ACL status, task state, outbound authenticated connection state and `device.status` result. Include a safe uninstall path retaining credentials unless explicitly purged.

### Track C: Enrollment / reachability

- [ ] Check Tailscale membership and live peer reachability on RTX, Vaulter, Surface and Leno. Tailscale itself may require a one-time sign-in on a machine. Enable Windows unattended mode if permitted. No private control listeners exposed to the public internet.
- [ ] Install the approved artifact side-by-side / safely on each machine. The same binary may be used everywhere; config, device ID, allowed directories, identity and credential file are unique per machine.
- [ ] Pair each logical device to the SAME existing relay account and Auth0-bound client identity; preserve existing paired IDs/credentials where valid rather than replacing them.
- [ ] Start outbound WSS from each agent to Vaulter's existing relay `/device` endpoint; verify one active session per expected ID. Verify local policy still decides execution.
- [ ] If no remote management channel exists, the irreducible bootstrap is one locally approved installer launch per machine, rather than repeated pasted PowerShell diagnostics. Subsequent operation should route through Tetherplane once authenticated acceptance passes.

### Track D: Acceptance and hardening

- [ ] From the authenticated HTTPS MCP edge, list exactly six tools, enumerate the four devices and call `device.status` on each with stable device identity.
- [ ] Per machine: one read-only `files` operation inside allowed root; one owned-process no-op; confirm outside-root denial; confirm human-owned process/foreground/tab interaction is denied by default.
- [ ] On Surface/Leno: verify owned background browser and accessible desktop flows without focus/cursor/clipboard changes. Do not run foreground-sensitive probes without presence/approval.
- [ ] On RTX: verify a bounded Tetherplane-owned GPU workload without taking over existing unrelated model processes.
- [ ] Test reconnect, temporary network loss, agent-process restart, sign-out/reboot and revocation individually. Do not assert restart/reboot readiness based solely on packaging CI.
- [ ] Run Leno operator-observed `docs/live-acceptance.md` and separate authenticated remote proof before public release tagging.

## Execution order and handoff gates

1. Immediately: Track A read-only incident inspection and Track B source-only artifact/bootstrap implementation can proceed in parallel.
2. First meaningful mesh milestone: all four agents paired, connected and `device.status` returning over the authenticated relay; original Vaulter supervisor MUST be stable before declaring this reliable.
3. Second milestone: policy-denial proof and bounded files/process proof on all four.
4. Third milestone: unattended/reboot recovery and observed human-coexistence acceptance.
5. Final: operator-reviewed release tag only after required gates, never inferred from CI alone.

## Operator UX target

After an authorized bootstrap channel is available, replace copy-paste scripts with a reviewed, verified package plus a one-time approved launch on each unpaired host. The orchestrator must report per-device progress, never merge host identities, and stop on any authorization, hash, ACL, port-owner, task or policy mismatch. Never use remote quota workarounds or unapproved computer access.

## Canonical references

- `docs/superpowers/specs/2026-09-17-tetherplane-design.md`
- `docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md`
- `docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md`
- `docs/superpowers/plans/2026-10-11-e21-rollback-guard.md`
- `docs/remote/self-host.md`
- `docs/remote/chatgpt-oauth.md`
- `docs/release.md`
- `docs/live-acceptance.md`
