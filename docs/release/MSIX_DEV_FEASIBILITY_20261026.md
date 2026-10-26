# Tetherplane — Microsoft Store MSIX feasibility spike

**Date:** 2026-10-26
**Branch:** `feature/msix-feasibility-20261026` from protected `main` `fc8590a7e997c01878ca4d85469d6ba8eae23882`
**Scope:** Test Windows MSIX package identity, native binary packaging, ephemeral development signing and install/remove behavior. **Not an installer, Store submission, publisher identity or production release.**

## Hypothesis

Microsoft Store can re-sign an approved MSIX, which could avoid purchasing a public-trust code-signing certificate **for the Store-distributed MSIX only**. Standalone GitHub Windows EXE/ZIP and enterprise/offline distribution still require independent signing.

## Experiment design

- Manifest: `packaging/msix-feasibility/AppxManifest.xml`.
- Ephemeral Windows runner: `.github/workflows/msix-feasibility.yml`, pull requests from same repository matching a `feature/msix-feasibility-` head only, GitHub Actions token `contents: read`.
- PowerShell runner: `scripts/msix/Test-TetherplaneMsixFeasibility.ps1`.
- Source contract: `tests/release/msix-feasibility-contract.test.mjs`.
- The runner compiles `target/release/tetherd.exe` from exact PR source. `MakeAppx.exe` packs a synthetic-logo package including the compiled agent; immediately unpacks it and verifies that native executable bytes are unchanged.
- A self-signed development-only Code Signing cert is generated in the ephemeral runner's user cert store (subject `CN=Tetherplane MSIX Development Probe`), used with SignTool only to test installation, then removed. **No PFX, private key, EXE or MSIX is uploaded.**
- Attempt `Add-AppxPackage` / identity inspection / `Remove-AppxPackage` in the temporary CI runner. An unsupported hosted-runner packaging/install environment produces a **failed job and recorded diagnostic**, not a false acceptance.
- Only a data-only `tetherplane-msix-probe-report.json` file is attached for inspection.
- Manifest does not declare a startup task or packaged service. The agent executable is *never launched*, paired, connected or installed on any of the four production devices.

## Verification matrix

| Gate | Pass condition | State before hosted CI |
|---|---|---|
| XML and PowerShell source parsing | Both parse without errors | Locally verified |
| Source isolation tests | All contract and negative-control tests pass | 4/4 local Node tests passed |
| Real Windows binary build | Rust build completes from reviewed source | CI pending |
| MakeAppx package and unpack | Package passes semantic validator; unpacked executable hash equals build | CI pending |
| Ephemeral package signature | Temporary dev certificate, SignTool sign and verify | CI pending |
| MSIX Add/Remove package | Registration and removal both succeed on disposable Windows runner | CI pending; runner restrictions possible |
| User-controlled startup | Background start requires informed user enabling, no silent Scheduled Task registration | Not implemented or tested |
| Complete Tetherplane behavior | Six tools, OAuth/DCR, denial, browser-offline recovery, update/rollback/uninstall | Not tested |
| Store approval | Valid individual publisher eligibility and successful certification | Not submitted |

## Hard boundaries

- Nothing changes `main`, its release workflow, OAuth clients, protected authorizations, four-device service status or `v*` tag freeze.
- The test package has an intentionally fake dev-only publisher. It **cannot** be used for public distribution and must not be rebranded as a verified publisher.
- This stage contains only `tetherd.exe`; it does **not** yet bundle the Node-based Compact MCP adapter or onboarding UX. Even a full green CI does not prove that Tetherplane works as an MSIX-installed agent.
- The Store route requires a user-visible authorization/consent experience and app eligibility; `runFullTrust` is declared but Store acceptance is not implied.

## Evidence format

Hosted CI uploads only JSON: runner, source SHA, source executable and package SHA-256, pack/unpack/sign/install/remove verdicts, cleanup verdict and failure boundary if any. No passwords, certificate private keys or code binaries are exported.

## References

- [Microsoft — Generating MSIX package components](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-manual-conversion)
- [Microsoft — App capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)
- [Microsoft — Sign MSIX package (self-signed dev testing)](https://learn.microsoft.com/en-us/windows/msix/package/sign-msix-package-guide)
- [Microsoft — StartupTask class](https://learn.microsoft.com/en-us/uwp/api/windows.applicationmodel.startuptask)
- [Microsoft — MakeAppx pack and unpack](https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool)

**Release decision:** NO-GO until Store eligibility, an end-to-end authorized clean installation, exact functionality, device denials, upgrade/rollback and independent publisher checks are complete.
