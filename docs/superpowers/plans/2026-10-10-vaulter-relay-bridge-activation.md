# Vaulter relay bridge migration — guarded activation plan

**Date:** 2026-10-10
**Target:** Vaulter, operator-controlled session only (never RDC on Vaulter).
**Status:** Source-only review, not approval to change the live task or authentication.

## Verified deployment baseline

- Leno device has the expected outbound WSS configuration to the private relay on port 10000. The socket and six MCP tool-discovery checks passed; authenticated device routing has not.
- Vaulter's live Auth0 relay at loopback port 8788 is managed by the Interactive Windows Scheduled Task named Tetherplane Relay. Its running original PowerShell launcher had SHA-256 5522BDE82C0750EA3223ABFCE6DCF965E2A36BEBAAD21754F8BA2F6F8F792DA8.
- The protected authentication directory holds an existing bridge credential and self-hosted authorization state. Do not print or rotate them during this migration.
- Private rollback checkpoint: relay-pre-bridge-b8afcfe768964e8786a5c229b866ea8d (original launcher, Auth0 configuration, device-registry snapshot, task definition).
- Staged bridge-enabled Auth0 configuration: relay-bridge-stage-d45e3ad24fc346bbb0c3bbdeddd7bf3f/auth-config-bridge-candidate.json. The running relay's compiled configuration loader accepted it with a dummy secret.
- Public JWKS and OpenID discovery are live through Tailscale Funnel. MCP protected-resource metadata still advertises Auth0, and private ports 10000/8443/9443/9445 remain tailnet-only.
- Tether-auth S4U supervised startup, automatic crash restart and unattended boot recovery were operator verified.

## Source-first implementation

The original relay PowerShell launcher references the original Auth0 configuration and has no bridge credential reference. Adding a process-environment variable alone therefore does not prove it will load the staged bridge-enabled config.

The proposed source-managed wrapper must invoke the real Node CLI with explicit --auth-config and --state-file arguments; do not call the original script as a child of a bridge wrapper. Its default mode is inspection only. Live mode requires explicit -Serve, the verified original named task and an empty loopback port 8788.

Required offline gates:
1. Fail-first tests for the exact native Node arguments, process-scoped secret inheritance, original Auth0 OIDC binding equivalence and preservation of the paired registry path.
2. Negative tests for missing/invalid credential, modified entrypoint, changed account bindings, failing child, and process-environment cleanup on Windows PowerShell 5.1 and PowerShell 7.
3. Verified original/updated runner hashes and protected ACLs, exact pinned Node entrypoint, valid candidate and unchanged Auth0 metadata; never place secret values into argv, Task Scheduler XML, logs, Git or chat.
4. Full repository CI and focused Windows contracts must pass on the exact proposed revision.

## Controlled deployment — separate maintenance authorization required

1. In a fresh Vaulter operator session, inspect Task Scheduler account, trigger, retry settings and task-owned process/creation time; verify hashes and protected backup.
2. Review the actual previous PowerShell launcher's restart/logging behavior, which is not automatically retained by the native CLI wrapper. The current Interactive task logon type does not prove reboot startup without an interactive user session.
3. Stage reviewed source bytes and a task-action candidate in a NEW protected directory, without replacing any live file. Check that task arguments contain only paths and nonsecret flags. Run read-only wrapper preflight.
4. With an approved maintenance window and staffed rollback path, stop only the positively identified task-owned relay. Verify port 8788 is empty; never kill an ambiguous Node process.
5. Change only the registered relay task action to the hash-verified wrapper, preserving the registered task's account and all other settings. Start once. Independently confirm task ownership, loopback listener, unchanged Auth0 issuer, public relay health, six MCP tools, protected/private route preservation and Leno reconnection.
6. If any gate fails, restore the original verified task action/launcher/config under independently proven ownership and port vacancy, restart the original Auth0 relay, and verify recovery before claiming rollback.
7. Test local device-assisted approval, a valid Auth0-authenticated MCP status operation and local policy denial before considering this bridge stage accepted.

## Later identity cutover — separate gate

The self-hosted auth server presently returns JSON rather than a browser-facing HTML form for GET /interaction/<uid>; verify ChatGPT-compatible browser login and consent UX before exposing the remaining public OAuth endpoints.

Publish only individually verified auth mounts and the more specific /auth/device-login exception to the relay; preserve public root, MCP discovery and all existing tailnet-only ports. Switch from Auth0 only after device identity is proven, with subject-account mapping verified against the existing paired registry. Require authenticated six-tool ChatGPT acceptance, refresh, revocation, reconnect and local policy denial before retiring Auth0.

**Stop:** Any unexpected process/task owner, failed hash/ACL/source/CI check, unknown retry behavior, changed device registry or bindings, missing rollback evidence, secret exposure or changed public/private route.
