# Windows hybrid background execution — release design gate (2026-10-29)

Status: **design candidate / not implemented or deployed**. Parent: draft PR #96 at `8fd0232ae6e1d3b1d6c57ce276987beaf89b9462`.

## Goal and minimal change

Preserve the four-device architecture, the six externally exposed MCP tools, existing Auth0 OAuth/DCR/scopes, Tailscale and relay, device credentials, and explicit browser/desktop permissions. Provide an *optional* boot-capable, low-privilege connectivity service for unattended VAULTER and a windowless, session-bound worker for interactive browser/desktop operations. Do not convert everything into a privileged Session 0 service or migrate existing Windows tasks implicitly. The existing native Scheduled Task path remains the default until this separate deployment mode passes acceptance.

## Strict capability boundaries

| Component | Process / session | May do | Must not do |
| --- | --- | --- | --- |
| Tetherplane core transport + supervision | Windows Service, Session 0, dedicated least-privileged service identity | Authenticate its existing device to the relay, route device status/capability availability, reconnect, supervise scoped IPC, maintain bounded audit/logs | Access human tabs, inject input into Session 1+, bypass policy, open arbitrary processes as SYSTEM, create OAuth clients or expand scopes |
| Filesystem, process, batch, job workers | Explicitly authorized user/session-scoped worker; preserve existing principal profile and allowed roots | Execute authorized operations only with user's existing OS access and local policy; return `capability_unavailable` if worker absent | Receive blanket machine-wide capabilities from service status, escalate to SYSTEM, interpret relay identity as local OS authorization |
| Authenticated browser host/extension | Authorized logged-in user session | Local extension pairing, explicit tab sharing, browser-only operations in approved context | Grant tabs on mere login, inherit service powers, access unshared browser frames or origins |
| Desktop worker | Authorized logged-in interactive desktop | Execute explicitly permitted UIA/background-safe work in selected session | Control Winlogon/secure desktop or other sessions, steal foreground or synthesize unapproved consent |
| Model client worker / other optional adapters | Existing per-user supervisor unless independently proven service-safe | Per-user background work under existing explicit configuration | Automatically inherit global service startup or machine privileges |
| Tethrd relay/watchdog (if installed) | Separate existing managed processes/tasks | Preserve current relay and watchdog supervision | Move into the Tetherplane service or merge process lifecycles without independently verified need |
| VAULTER relay hub | Preserve current relay identity and process ownership | Serve authenticated connections while no user is logged in | Depend on browser availability or a human desktop session for core connectivity |

**Crucial distinction:** the core service being online does *not* advertise browser, desktop, or user-scoped file/process capabilities as available when there is no authorized interactive session. Routing must enforce the correct principal and target-session identity on every invocation.

## IPC / identity contract (must be specified and tested before code)

- Use local-only Windows IPC (e.g., named pipe) with explicit ACLs for the service SID and the intended signed-in user SID; use peer identity checks and random, short-lived challenge material. No anonymous local TCP listener; no reusable cross-session bearer token.
- Bind every operation to `device_id`, authenticated relay principal, locally authorized capability, worker user SID, Windows session ID, exact operation, and request/attempt identifier. Reject target/user/session substitution and stale or replayed requests.
- Restrict service to transport and orchestration: do not expose unrestricted `CreateProcessAsUser`, token duplication, impersonation or arbitrary commands as a service RPC.
- Pin mutually compatible service/user-worker binaries, install receipt ownership and version; reject a mismatched/unknown worker.
- Stop/restart, login/logout, session switch, credential loss, browser pairing expiry and relay reconnect must fail closed without replaying uncertain mutations.

## Reproducible installation plan

1. Preserve current signed/native Scheduled Task installation and production identity. Produce independent, test-only artifacts at a reviewed exact commit. Never overwrite a running task, touch an unrelated install prefix or remove shared autorun entries.
2. Add headless core/worker IPC contract tests (RED first) using synthetic Windows principals and mock local sessions only; verify refusal of unknown principal/session, missing user worker, wrong token, browser consent absent, worker exit, replay, and malformed credentials.
3. Implement optional service launch with a dedicated least-privileged identity and SCM controls, but *no browser/desktop privileges in Session 0*. Keep existing per-user task mode fully operational and compatible.
4. Run Windows acceptance in a clean disposable VM: signed install, no visible terminal, user not logged in, core status responsive, browser/desktop correctly unavailable, user login/explicit browser pairing, user logout, service restart, emergency relay outage, duplicate agent refusal, and rollback. Record PID trees, task/service inventory, RPC traces, log bounds and exit codes.
5. On VAULTER first, after a **separately approved maintenance window**, prove service core reachable before login while browser absent; verify legacy relays and auth boundaries unchanged. Then separately assess Leno, RTX and Surface only after backup, signed package and independent repeatable tests.

## Acceptance / release blockers

- **Surface**: Tailscale reports `Sohaib-Surface` online; Tetherplane `device.status` says disconnected. SSH 22 and WinRM 5985 respond, but SSH host-key trust is not established. Do not disable host key verification; use local read-only task/agent diagnosis and verified pairing path.
- **Leno**: authenticated core/browser currently healthy, existing user-specific canary is unsigned. Do not replace it.
- **RTX / VAULTER**: authenticated device status responds; this is not proof of reboot or unattended recovery.
- **Installer / uninstaller**: draft #96 source native task ownership is CI-tested; uninstall ownership and `-Force` install-prefix safety remain unresolved. Preserve unrelated tasks and state.
- **Signing**: approved public-trust Authenticode identity, trusted workflow, source/ZIP digest verification and clean install have not been established.
- **Four-device gate**: real authenticated status and correct denials for all four devices, no-user VAULTER, foreground safety, restart and rollback must be independently attested.
- **Release policy**: no merge, release tag, OAuth/DCR registration, protected config change, service deployment or task deletion without explicit approval.

## Decision checkpoints

- **D1:** exact current service/relay ownership + Session 0 threat model independently reviewed.
- **D2:** fail-first IPC identity/capability tests + no regressions of six-tool contract.
- **D3:** clean Windows VM demonstration including no visible console, no-user core service, explicit consent and logout denials.
- **D4:** signed installer + package provenance and verified rollback.
- **D5:** separate VAULTER pilot with approved outage window, then four-device acceptance.

Design success is measured by authorized device onboarding and genuine authenticated RPC, not SCM's `Running` status, a listening TCP port, or unit tests alone.
