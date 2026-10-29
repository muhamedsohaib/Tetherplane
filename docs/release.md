# Release and Installation

## Windows package

scripts/package-windows.ps1 builds release tetherd, builds TypeScript packages, deploys production Compact MCP and relay dependencies, preserves the canonical adapter/protocol schema layout, and writes a source-commit manifest.

The device-side installer copies only the local runtime by default. Relay artifacts remain in the package and can be included explicitly with -IncludeRelay.

No credential is generated or embedded by the packager.

## Installer behavior

scripts/install-windows.ps1 is per-user by default and accepts explicit -InstallPrefix and -StateDir values.

It does not change PATH. It does not install a scheduled task unless -InstallScheduledTask is explicitly supplied with a JSON argument file.

The scheduled-task argument file must contain tetherd arguments, not raw credential values. Use credential-file paths for device secrets.

## Uninstall behavior

scripts/uninstall-windows.ps1 removes the Tetherplane install prefix and a Tetherplane-owned scheduled task recorded by the install receipt.

Ordinary uninstall preserves state. -PurgeState is accepted only when the install receipt says the installer created that state directory.

## Verification

The Windows smoke test creates an isolated temporary package/install/state/root, starts the installed Compact MCP, asserts the exact six-tool surface, uninstalls, verifies binaries are gone, and verifies ordinary uninstall preserved state.

Run:

    powershell -NoProfile -ExecutionPolicy Bypass -File tests/release/windows-package-smoke.ps1

## Live acceptance gate

Before creating the public `v0.1.0` tag, follow `docs/live-acceptance.md`.

Preparation is non-interactive and uses a side-by-side LocalAppData install:

    node scripts/live-acceptance.mjs --prepare

The observed local phase requires the operator physically present at Leno:

    node scripts/live-acceptance.mjs --live --user-present

A separate authenticated remote MCP call to Leno must also pass while the operator observes that human-owned foreground state is not disrupted. The acceptance runner does not handle or print relay credentials.

## Tagged release automation (currently disabled)

`.github/workflows/release.yml` is intentionally **fail-closed**: any `v*` tag invokes a job that throws `UNSIGNED_PUBLIC_RELEASE_BLOCKED`. It does **not** create a ZIP, sign a binary, or publish a GitHub Release. Creating `v0.1.0` while this block is in place is not an authorized release path.

The isolated evidence in draft PRs #105–#106 establishes package self-consistency and independently verifiable GitHub/Sigstore workflow provenance for a quarantined **unsigned** archive only. It is not Windows Authenticode signing, a trusted promotion procedure, proof of a clean authorized machine, human-observed coexistence, or authenticated four-device acceptance.

Before an owner-approved release: settle code-signing identity/key custody, verify an exact signed candidate independently, complete disposable upgrade/rollback and operator-observed Windows acceptance, and validate authenticated operation and denial behavior on the required four devices. Preserve the publication block until these gates are explicitly approved.
