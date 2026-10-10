# Vaulter supervised bridge: incremental source integration

Date: 2026-10-10
Status: source-only feature branch; NO live Vaulter deployment approval.
Baseline: protected original Auth0 relay recovery tested under source 7dcc467. Preserve it unchanged on Vaulter.

## Goal

Launch the bridge-enabled relay as a CHILD of the same bounded PowerShell supervisor, not as a replacement direct Scheduled Task action. Keep original Auth0 OIDC bindings, preserve the paired device registry, retain localhost port 8788, and preserve bounded automatic recovery. Never rotate tokens or make a self-hosted issuer cutover in this phase.

## Non-negotiable contracts

- Current installed Auth0 supervisor remains untouched until a separately approved protected bridge stage and verified task handover.
- The new mode is opt-in: \`-Serve -Bridge\`, only from a new protected \`relay-supervisor-bridge\` directory. Default \`-Serve\` keeps launching the EXACT original protected action.
- Only the registered \`Tetherplane Relay\` task may own the bridge supervisor. The existing global mutex, port-vacancy and bounded restart loop remain in use.
- Bridge-child manifest pins bridge helper, launcher, config, Node runtime/CLI and protected rollback task; no credentials in XML, argv, logs, manifest or Git.
- The native launcher may run \`-Serve -Supervised\` only when its actual PowerShell parent is the registered protected bridge supervisor. Existing direct task ownership remains a separate compatibility mode, not the migration path.
- The native launcher passes \`--auth-config\` and \`--state-file\` explicitly; the bridge credential is inherited only by the Node process from protected state.
- All parent and child integrity/identity failures fail closed. Do not terminate arbitrary or human-owned processes.
- New task registration must preserve task principal, triggers, settings and working directory; rollback must restore the verified PRE-BRIDGE-SUPERVISOR task registration, not revert blindly to unsupervised Auth0.
- No changes to the Funnel root, public issuer, JWT keys, JWKS mounts or private ports 10000, 8443, 9443 and 9445.

## Implementation sequence

1. RED test: source exposes a strictly opt-in supervised bridge launch, validates a protected secret-free manifest, and constructs an exact native PowerShell child action.
2. GREEN: implement bridge launch descriptor and bind it to the unchanged bounded restart loop. Exercise a REAL synthetic Windows child exit/relaunch without live services.
3. RED/GREEN: allow the existing native bridge launcher to run under the validated registered supervisor ancestry, without weakening its direct-mode guard or exposing secrets.
4. RED/GREEN: implement a NEW protected stage and guarded action-only bridge handover with rollback to the already-proven supervised Auth0 registration. Reject any existing install directory, source/hash drift, task or port conflicts.
5. Pass focused Windows PowerShell 5.1/7 contracts and the complete Windows/Ubuntu repository CI at the exact feature commit.
6. Live Vaulter: separately authorize read-only preflight, protected staging, controlled activation, independently verified same-supervisor recovery and authenticated Leno device routing. No cutover to tether-auth in this gate.

## Verification and stop conditions

- Each behavior must fail its targeted regression before implementation, then pass after.
- Never claim live recovery from synthetic CI or from a task exit code.
- Do not use Remote Desktop Commander on Vaulter.
- Leno canonical working tree must be reconciled before any Leno-local development; GitHub feature branch is persistent source work.
- Abort on missing stage, unexpected ACL/owner, modified launcher or protected rollback, wrong task action, incorrect Auth0 binding, auth PID drift, port conflict, unproven source SHA or rollback uncertainty.
