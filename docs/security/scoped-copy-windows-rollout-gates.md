# Scoped filesystem.copy — Windows agent-only release gate

**Status: draft; not a deployment authorization.** The six canonical MCP tools
must remain unchanged. An ordinary green CI run proves neither a genuine
signed update nor live-device reliability.

## Verified prior state, 2026-10-20

- Vaulter's installed agent reports 0.1.0 / windows x86_64 / background_only.
- Launch-bound principal: operator:sohaib-vaulter-limited.
- The principal's allowed_directories and the agent's --allow restriction
  both point to a single dedicated Tetherplane Workspace directory.
- Within that directory, direct filesystem.write and read-back passed, and
  read-followed-by-write text copying matched. Outside-root read/list requests
  were denied. Native filesystem.copy remains **unavailable** on this live agent.
- Agent and TetherAuth have independent scheduled tasks. Do not restart the
  TetherAuth or relay tasks as part of a copy-only update.

## Phase A — isolated Windows package acceptance (no live changes)

On an authorized Windows build runner, test the **installed package binary**:

    node tests/release/windows-agent-copy-canary.mjs --tetherd <absolute-path-to-staged-tetherd.exe> --scratch-parent <disposable-test-directory>

The script spawns a disposable stdio-rpc agent and a synthetic launch-bound
principal in an unpredictable scratch subdirectory. It **does not** access or
modify the installed Vaulter agent, its scheduled task, credential file, real
principal profile, relay, or OAuth service.

Required result: PASS_INSTALLED_AGENT_COPY_CANARY including binary SHA-256
match, no source removal, no-destination-replace, unbound principal denied,
ungranted capability denied, and both source/destination outside-root denied.

This is automatically exercised against the installed binary in
tests/release/windows-package-smoke.ps1 on Windows CI.

## Phase B — operator-approved Vaulter preflight (read-only)

Before requesting a real production update, independently record:

1. Current healthy device.status and device.capabilities over authenticated
   Tetherplane, including negative-path permission_denied.
2. Exactly which executable PID and binary path belong to the running Vaulter
   agent, its Windows scheduled-task **Actions**, signer, SHA-256, process
   ownership, service account, command-line switches and --allow roots.
3. The launch-bound principal file location, allowed_capabilities and
   allowed_directories **without printing raw credential or signing data**.
4. Source-controlled candidate binary SHA-256, source commit, verified Windows
   package manifest, Authenticode signature, packaging logs, and matching
   successful Windows/Ubuntu CI. Do not infer signing from CI alone.
5. Existing agent rollback artifact and hashes, task configuration and
   credential-file references recorded and stored with appropriate ACLs,
   separated from the candidate build.
6. A bounded, controlled agent-only restart/rollback procedure proven against
   a disposable Windows installation, without deleting unrelated files.
7. Explicit human approval for the exact binary SHA, affected scheduled-task
   name and brief maintenance window. General permission to continue
   development is not deployment approval.

If any prerequisite is missing: NO_GO, leave Vaulter unchanged.

## Phase C — controlled live acceptance (separate approval)

Only after approval and proven safe rollback:

- Stage the candidate **side-by-side**, preserving the known-good binary,
  agent task action, principal profile and credential-file reference.
- Add **only** filesystem.copy to the approved principal capability set;
  retain the exact previous allowed_directories and --allow restrictions.
- Restart **only** the relevant Tetherplane Vaulter agent. Never touch
  TetherAuth's SQLite, signing keys, OAuth/DCR clients, issuer, scope rules,
  relay or unrelated Windows tasks.
- Verify authenticated device.status and capability advertisement, then
  copy a disposable small binary within the authorized workspace and compare
  SHA-256 digests. Verify source preservation and no overwrite.
- Independently verify source and destination outside-root denials, no
  process.run escalation, and unchanged six-tool MCP surface. Check agent
  recovery and task health; collect sanitized receipts.
- If any check fails, restore the exact known-good agent binary/profile/task
  settings via the previously rehearsed agent-only rollback procedure and
  independently verify old agent reachability and protected-service stability.

## Release-blocking exclusions

An ordinary Windows package install smoke or isolated stdio canary does not
demonstrate a signed installation, real Vaulter authenticated transport after
a task restart, production rollback, surviving Tailscale loss, or four-device
acceptance. Keep NO_GO until the precise missing evidence is recorded.
Do not invoke scripts/install-windows.ps1 with -Force against an existing
Vaulter installation; it can recursively remove the install prefix.
