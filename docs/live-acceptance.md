# Tetherplane v0.1.0 Live Acceptance

This is the final operator-observed gate before creating the public `v0.1.0` release tag.

The gate is intentionally split so preparation can finish without a person sitting at Leno, while the coexistence-sensitive steps only run when the operator is physically present.

## Safety boundary

The acceptance runner:

- requires Windows for execution;
- requires local `main` to be clean and exactly equal to `origin/main`;
- creates only a side-by-side Tetherplane-owned acceptance install under `%LOCALAPPDATA%\Tetherplane\live-acceptance\v0.1.0`;
- does not register or replace the production scheduled task;
- does not move the physical cursor or request foreground fallback;
- does not publish a release tag;
- does not print, copy, or persist relay credentials.

Machine-readable stage metadata lives in `scripts/live-acceptance-plan.json`.

## 1. Inspect the plan

This is side-effect-free:

    node scripts/live-acceptance.mjs --describe

## 2. Prepare before the operator sits at Leno

Run:

    node scripts/live-acceptance.mjs --prepare

Preparation proves:

1. local source is clean `main` and equals `origin/main`;
2. a Windows v0.1.0 candidate package builds from that exact commit;
3. the candidate installs into an isolated side-by-side prefix;
4. the installed manifest records the same source commit;
5. the installed Compact MCP exposes exactly six default tools;
6. debug/runtime dependencies needed by the observed browser and desktop stages are built.

Expected final markers:

    LIVE_ACCEPTANCE_PREPARED=True
    USER_PRESENCE_REQUIRED_FOR_NEXT_PHASE=True

Do not continue to the next phase until the operator is physically at Leno.

## 3. Operator-observed local live phase

When the operator is sitting at Leno, keep an ordinary human-owned window active and continue normal mouse/keyboard use.

Run:

    node scripts/live-acceptance.mjs --live --user-present

The runner revalidates source truth and the prepared candidate, then executes:

- installed six-tool MCP smoke;
- local filesystem/process/batch benchmark;
- verified semantic browser workflow in a Tetherplane-owned isolated browser context;
- Windows UI Automation semantic desktop workflow.

During the observed phase, the operator should confirm that Tetherplane does not:

- steal keyboard focus;
- move the physical cursor;
- overwrite the global clipboard;
- navigate or activate an unrelated human-owned browser tab;
- move/minimize/maximize a human-owned window.

The desktop benchmark also programmatically asserts that the physical cursor remains unchanged.

Required terminal markers:

    LOCAL_LIVE_ACCEPTANCE=PASS
    REMOTE_PLANE_LIVE_PROOF_REQUIRED=True
    RELEASE_TAG_ALLOWED=False

A local pass is not enough to publish v0.1.0.

## 4. Separate remote-plane live proof

With the operator still watching Leno, use a separately paired Tetherplane client to make a real authenticated MCP call through the relay to Leno.

Minimum proof:

1. initialize an authenticated MCP session;
2. call `device.status` on Leno;
3. run one harmless Tetherplane-owned process command such as an echo;
4. confirm the result returns through the relay;
5. close the MCP session;
6. confirm Leno's human-owned active window, cursor, and browser tab were not disrupted.

Use the existing authenticated client mechanism. Do not print a bearer token or device credential to obtain this proof.

Record only pass/fail evidence and non-secret identifiers.

## 5. Windows session stages (lock / sleep / reboot)

These stages come from [WINDOWS_ACCEPTANCE_PLAN.md](/workspaces/Tetherplane/docs/WINDOWS_ACCEPTANCE_PLAN.md) and run only on Leno with the operator present. A Linux host reports every stage `unverified` and must never self-certify them. Run them after the remote-plane proof and before cleanup, in plan order:

1. `windows_locked_workstation` — lock Windows; verify device/files/process/job operations still succeed, already-connected browser semantic ops behave as observed (record the actual result), desktop snapshot/act return the observed truthful state (expected: fail closed, never fake success), and physical pointer ops are denied without a lease.
2. `windows_unlock_recovery` — unlock; verify the desktop capability returns to `ready` only after a live UIA probe, and stale references fail `stale_reference` without targeting the lock screen or another window.
3. `windows_sleep_wake` — sleep at least 2 minutes (past the foreground-lease TTL), wake; verify leases expired, handles are invalid, the relay reconnects on a new generation within 30 s of network return, and no mutation replays.
4. `windows_reboot_logon` — restart the OS; verify the agent is offline before logon (record the AtLogOn limitation as stated, not as a failure), auto-starts at logon, durable jobs/idempotency survive, and a fresh authorized op succeeds with no manual step.
5. `browser_runtime_onboarding` — on a fresh install with no Chromium, verify the browser reports `disconnected`/not-installed truthfully (not "installed successfully"); after installing Chromium and pairing the extension, verify the browser reaches `ready` only on a real `pages` probe.
6. `windows_resource_baseline` — record working-set idle and cold start via `scripts/bench-local.ps1` beside the Linux floor; investigate variance before claiming the <250 ms target.

Record each stage in its `observed_outcome` block in `scripts/live-acceptance-plan.json`: initial state, injected fault, observed transition, recovery seconds, final state, and independently verified outcome (file bytes / counters / operator observation), plus observer, timestamp, and machine. Flip `status` from `unverified` to `pass`/`fail` only with the observation in hand.

Known limits that are recorded, not certified away: no agent before logon or after logoff with the current AtLogOn registration; secure-desktop surfaces are not automatable by design; certification covers the tested machine only.

## 6. Cleanup

After local, remote, and Windows session proof are complete:

    node scripts/live-acceptance.mjs --cleanup

Cleanup is explicit because it removes the Tetherplane-owned side-by-side acceptance install and its temporary state. It does not touch the normal production install.

Expected marker:

    LIVE_ACCEPTANCE_CLEANUP=PASS

## 7. Release tag

Only after the operator-observed local phase, the separate remote-plane proof, and the Windows session stages pass should `v0.1.0` be created.

Pushing that tag triggers `.github/workflows/release.yml`, which rebuilds and re-verifies the Windows package, creates the ZIP/checksum, and publishes the GitHub Release.

Do not create the tag merely because CI is green; live acceptance is the final publication gate.
