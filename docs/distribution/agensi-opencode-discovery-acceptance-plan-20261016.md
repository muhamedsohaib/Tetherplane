# Agensi Starter — clean OpenCode discovery acceptance plan (2026-10-16)

## Authority and scope
Canonical Tetherplane design, 2026-09-17 roadmap/local core and existing Agensi Starter plan govern. Work only in isolated Agensi branch; do not touch installed OpenCode sessions, Leno live agents, human tabs, credentials or production relay.

## Objective
Independently prove that the **exact ZIP** assembled by `scripts/package_starter_skill.py` registers `tetherplane-starter` within the supported OpenCode v2 host on a disposable clean Ubuntu runner. This is *host discovery*, not model execution or end-to-end MCP control.

## Red-green steps
1. Add a failing unittest to `tests/skills/test_starter_contract.py` verifying GitHub starter-skill CI installs the pinned OpenCode v2 CLI, invokes `tests/skills/opencode_host_acceptance.py` on the built ZIP, and does not omit starter safety checks.
2. Run failing test and confirm the missing workflow step caused the failure.
3. Implement `tests/skills/opencode_host_acceptance.py`:
   - Treat ZIP as untrusted; extract only allowlisted UTF-8 regular files under one known folder, rejecting traversal and links.
   - Create a temporary isolated git project under the runner's temp directory and place the skill in `.opencode/skills/tetherplane-starter/`.
   - Start a short-lived OpenCode HTTP server bound to 127.0.0.1, with ephemeral Basic-auth credentials that are never logged.
   - Probe server readiness then poll `/api/skill` until the `tetherplane-starter` skill is returned; enforce a deadline and reject a missing skill.
   - Stop and wait for only the test-created server in a `finally` block.
4. Add the smallest CI steps to run the test on the exact package. Keep package generation and independent lint/contracts unchanged.
5. Confirm unittest RED to GREEN, complete Python starter suite, repo hygiene and diff checks; push the reviewed feature branch.
6. Inspect the exact SHA's GitHub Actions; if host discovery fails, preserve the failure and debug without bypassing the gate. Do not claim model invocation or public readiness.

## Exit
OpenCode discovery proven on disposable runner; marketplace upload and model invocation remain separately gated. No marketplace submission, public release, external communications, paid service or production network changes.
