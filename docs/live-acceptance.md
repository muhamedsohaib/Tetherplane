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

## 5. Cleanup

After local and remote live proof are complete:

    node scripts/live-acceptance.mjs --cleanup

Cleanup is explicit because it removes the Tetherplane-owned side-by-side acceptance install and its temporary state. It does not touch the normal production install.

Expected marker:

    LIVE_ACCEPTANCE_CLEANUP=PASS

## 6. Release tag

Only after both the operator-observed local phase and the separate remote-plane proof pass should `v0.1.0` be created.

Pushing that tag triggers `.github/workflows/release.yml`, which rebuilds and re-verifies the Windows package, creates the ZIP/checksum, and publishes the GitHub Release.

Do not create the tag merely because CI is green; live acceptance is the final publication gate.
