# GitHub developer-beta release gate — 2026-11-04

**Decision: Prepare only; do not publish.** This document concerns the next **open-source, unsigned Windows developer beta**. The owner explicitly ruled out mandatory code signing, MSIX, or Microsoft Store distribution. This document is not authorization to merge, tag, publish, change protected identity, install agents, or weaken any Windows security policy.

## Actual repository and release state

- Repository: `muhamedsohaib/Tetherplane`.
- Current remote `main` was `fc8590a7e997c01878ca4d85469d6ba8eae23882` when inspected from Leno on November 4, 2026.
- A public **v0.1.0** GitHub release already exists (published September 26, 2026). A **v0.1.1-rc.1** GitHub release is an unpublished draft with no assets. Neither should be edited or replaced silently.
- Current `main:.github/workflows/release.yml` intentionally rejects all `v*` tag-triggered unsigned publication with `UNSIGNED_PUBLIC_RELEASE_BLOCKED`. **Do not remove or bypass this protected publication guard.**
- Isolated local branded-toast source: `feature/windows-toast-branded-icon-20261103` on Leno. It is not merged into remote `main`.
- The existing **16-file toast ZIP** is a synthetic diagnostic kit, **not a full Tetherplane installer**. It includes a native toast smoke binary, a loopback test-only agent, approved ICO assets, source/binary provenance and checksums. Never publish that kit as the full product.

## Product acceptance — minimum honest developer-beta evidence

| Gate | Current evidence | Decision |
| --- | --- | --- |
| Approved monochrome icon | Both owner-supplied images hashed; nine ICO resolutions each reproduced byte-identically | PASS |
| Unpackaged WinRT toast identity | Per-user shortcut with `ARCUSLabs.Tetherplane.DevBeta`, correct `IconLocation`, history accepted, rollback verified | PASS (Windows history, not visible icon) |
| Native toast on Leno | Windows Application Control blocks exact pinned unsigned binary before dispatch; script now reports `BETA_WINDOWS_APPLICATION_CONTROL_BLOCKED` and cleans up | HOST INCOMPATIBILITY; DO NOT BYPASS |
| Native toast on a permitted Windows host | Prior isolated acceptance of unsigned native smoke and synthetic authenticated relay 101 / denied 401 events was recorded separately; human-visible icon was not independently verified | PARTIAL |
| Agent coexistence | Read-only Leno canary verified expected running agent, original hash, and unchanged arguments file path; protected agent not replaced | PASS for non-interference; recovery unproven |
| Authenticated device operations | Current Leno `device.status` works; previous snapshots showed other authorized device connections, but the complete four-device state was not retested in this Leno-only follow-up | PARTIAL |
| Unauthorized operation denial | Previous separate restricted-principal tests denied unauthorized process and filesystem capabilities | SUPPORTING, not full release-candidate regression |
| Independent clean-machine onboarding | No independently accepted fresh authorized Windows installation of the exact proposed source-built candidate | BLOCKED |
| Actual release ZIP and rollback | Exact commit, full Windows runtime package, install/uninstall and rollback must be tested on a clean machine; the diagnostic toast kit is not a substitute | BLOCKED |
| User-visible notification artwork | Correct shell shortcut icon and decoded ICO verified; Windows notification history is **not** proof that the visible popup used the branded icon | NOT YET HUMAN-VERIFIED |

## Safe release lane that does not require signing or MSIX

**Recommended:** Treat toast notifications as an explicitly opt-in experimental beta feature; do not make a tray icon, splash screen, Microsoft Store identity, or code-signing process a prerequisite for an otherwise functional open-source developer beta. **Do not claim native toast support on Windows hosts with enforced unsigned-code restrictions.**

1. On a separately authorized clean Windows installation, reproduce the complete *Tetherplane* installer and authenticated MCP connection from the **exact intended candidate commit**. Measure setup friction and record one permitted tool call, one denied operation, clean uninstallation and recovery. No security-control bypasses.
2. Build the full runtime ZIP (not the toast diagnostic ZIP) in a trusted, reproducible CI workflow with source SHA, hashes, dependency manifests, license files, and instructions. Check that it installs with **per-user default** and no automatic scheduled task without consent.
3. Keep the existing `v*` signed-release blocker unchanged. After explicit owner approval, use a **separate manual GitHub prerelease** route with a distinct non-`v*` beta tag namespace and explicit approved artifact/source hashes. This must not automatically merge, publish, alter authentication, or trigger any protected release action. Do not reuse the pre-existing `v0.1.1-rc.1` draft without the owner's specific decision.
4. Mark the GitHub release **Pre-release**, state clearly that binaries are unsigned, provide independent checksum verification steps, supported Windows versions, Windows Application Control limitations, self-build guidance, opt-in notification instructions, known issues, and rollback.
5. Obtain owner approval for the **specific commit, tag, assets, and public release text** before creating/publishing the release.

## Immediate next step

Obtain a clean-install acceptance trace for the full runtime package on an authorized machine and verify the unsigned executable runs under that machine's **existing** security policy. On Leno, use only read-only checks and disposable non-agent experiments until the external security policy permits native execution; do not attempt policy changes.

**Status as of this Leno-only checkpoint: Not GO for a new public developer-beta prerelease.** The toast implementation itself is viable as opt-in; new-user onboarding and candidate-specific release evidence, not mandatory signing/MSIX, are the decisive gates.
