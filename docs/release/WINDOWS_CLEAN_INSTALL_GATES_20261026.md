# Tetherplane — cold-install fail-closed gate (nonrelease)

Date: 2026-10-26. Base: protected main `fc8590a7e997c01878ca4d85469d6ba8eae23882`.
Branch: `fix/windows-clean-install-gate-20261026` (draft only, do not merge without approval).

## Observed risk in protected main

1. `packaging/windows/tetherplane-mcp.ps1` initializes PowerShell variables **before** `param`; under Windows PowerShell this prevents `param` from being the proper script-parameter block.
2. `scripts/install-windows.ps1 -Force` deletes a populated installation prefix **before** scheduled-agent argument validation. A failed retry can destroy a prior working installation. The same script could unregister an existing Tetherplane Agent task if `-Force` is supplied, without a separately verified migration.
3. `tests/release/windows-package-smoke.ps1` already builds and installs a runtime into an isolated temp prefix, lists all six advertised Compact MCP tools, and uninstalls while preserving a state sentinel. Its `SIX_TOOL_SMOKE_OK` is **tool discovery**, not actual six-tool operation or OAuth/DCR onboarding.

## Minimal isolated changes

- Move the PowerShell `param` block to the first statement of `tetherplane-mcp.ps1`.
- Fail closed if install and state roots overlap.
- Validate scheduled-agent argument file presence and JSON array, nonempty strings, required relay/device/credential-file flags **before** any installed-file writes.
- Refuse replacing a populated install prefix even with `-Force`; safe upgrades must use a separate, approved, versioned migration with rollback.
- Refuse overwriting an existing `Tetherplane Agent` Scheduled Task; no automatic unregister/replacement.
- Preserve existing four-device architecture and OAuth/DCR client registrations unchanged.

## Controlled Windows regression

Two complementary jobs:
- Linux release-policy Node source contract: `tests/release/windows-clean-install-contract.test.mjs`, including security negative controls.
- Hosted disposable Windows pull-request test: `tests/release/windows-clean-install-preflight.ps1`, which constructs **synthetic package fixture files** in a unique private runner temp directory, and checks:
  * `-Force` plus malformed JSON cannot delete or change a pre-existing sentinel;
  * `-Force` on a populated install is denied;
  * overlapping install/state directories are denied without writes;
  * malformed agent arguments leave no partial fresh install;
  * safe fresh file install produces expected files and receipt, with no global scheduled task;
  * a second install into the same populated prefix is denied;
  * Compact MCP launcher has a genuine top-level PowerShell AST parameter block;
  * all test-created temporary files are removed by a strict runner-root cleanup guard.
- The Windows CI test runs only on same-repository `pull_request` in an ephemeral GitHub-hosted Windows environment. It does **not** create a scheduled task, connect to a relay, use actual credentials, touch a production agent, generate a signature, execute a binary, or publish a package. It uploads **only a JSON report**.

## Explicit limits and remaining gates

Even if this regression is all green, it proves an isolated **synthetic cold-file install and fail-closed error handling**. It does **not** prove:
- real executable signing or public Store certification;
- owner consent or OAuth/DCR enrollment on a clean machine;
- target-host remote API functionality after setup;
- true first-user onboarding effort, reboot persistence, upgrade/rollback and uninstall in an independent Windows VM;
- all four devices tested on a matched release candidate.

For recording: **do not start the clean-install demo yet**. Prepare an explicitly authorized disposable Windows 11 machine and test publisher/identity strategy. Preserve raw video of the very first real installation attempt, including any failure; do not claim a synthetic CI smoke is new-machine acceptance.

**Release gate remains NO-GO.**
