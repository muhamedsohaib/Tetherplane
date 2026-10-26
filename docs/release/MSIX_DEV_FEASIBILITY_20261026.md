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

## Hosted CI observation — first run

- GitHub Actions run `40289595837` failed at the Node source-contract test, **before the Rust build, MakeAppx packing, certificate creation or Appx installation steps**.
- Direct job logs identified Windows CRLF checkout of the YAML workflow; the test incorrectly required LF-only input. The manifest and runner-script text are now normalized to LF in the Node test harness before matching, like the repository's established release-policy tests.
- This was a **test portability bug**, not evidence that MSIX packaging succeeded or failed. A new hosted run is required for the actual MSIX verdict.

## Hosted CI second run — package success, self-signed trust boundary

- GitHub Actions [run 40289987626](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40289987626) passed native Rust release build, MakeAppx semantic packaging, MakeAppx unpack, and binary byte-integrity check. SignTool applied the temporary development signature.
- **Failed boundary:** `signtool verify /pa /v` reported that the self-signed developer certificate chain terminated in an untrusted root. The package was **not** installed; this is a development-only trust setup issue, not public signing success.
- Corrective isolated change: install the **public-only** generated development certificate into `CurrentUser\Root` as well as `CurrentUser\TrustedPeople` in the GitHub-hosted disposable runner, then remove it from both stores and `CurrentUser\My` in the existing `finally` cleanup. This is prohibited on production devices by the runner guard.
- **Never** transfer that development trust root or private key to a real user computer or treat the self-signed probe as a commercial signature. Re-run hosted CI to verify whether registration/removal is supported by the runner.

## Fourth-run plan: bounded phase evidence, no root-store trust

- The prior third run `40290661582` was **cancelled** after no further output for ten minutes following MakeAppx extraction. It produced no JSON evidence artifact, so the exact blocked cmdlet was **not observed**. Do not assert that `Import-Certificate` itself was proven to hang.
- Microsoft MSIX developer guidance recommends importing the **public-only** self-signed certificate into `LocalMachine\\TrustedPeople` for local test installation, not broadly trusting a development certificate in `Root`. The probe now targets `LocalMachine\\TrustedPeople` on its disposable hosted Windows runner and explicitly deletes the imported leaf and CurrentUser/My signing certificate in `finally`.
- The PowerShell probe writes a data-only JSON checkpoint **before** native package creation, unpack, certificate creation, certificate import, signature verification, Add-AppxPackage, and removal. Output markers `MSIX_PHASE=...` delimit operations.
- The dedicated Node wrapper restricts execution to the GitHub-hosted pull-request runner and limits the PowerShell subprocess to **120 seconds**, after which the job fails with the last persisted phase rather than waiting indefinitely.
- The MSIX workflow job timeout is reduced from 45 to 20 minutes. Only the JSON report may be uploaded. No production OAuth, device, Windows Scheduled Task, Store identity or release rule changes are made.
- Leno checks: Node contracts **5/5**, existing unsigned-publication guard **4/4**, PowerShell parser **0 errors**, JavaScript syntax PASS, locally executed wrapper **exit 1 / explicit denial**. These results do not prove the hosted MSIX can install or run Tetherplane.
- Source references: [Microsoft MSIX signing guidance](https://learn.microsoft.com/en-us/windows/msix/package/sign-msix-package-guide); [Microsoft MSIX troubleshooting — untrusted certificate](https://learn.microsoft.com/en-us/windows/msix/msix-troubleshooting-guide).

## Bounded run result — GitHub's child PowerShell command resolution

- GitHub Actions [run 40295629684](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40295629684) built the native release binary, started the bounded PowerShell child process, and persisted a JSON failure report. The child passed its runner guard, then failed before MakeAppx packaging with: **`Get-FileHash` is not recognized**. The earlier direct CI PowerShell step had resolved that cmdlet, so this is a difference in child PowerShell initialization/available modules.
- Evidence downloaded to Leno: `MSIX_Run_40295629684/tetherplane-msix-probe-report.json`. Fields: `package_pack=NOT_RUN`, `add_appx=NOT_RUN`, `certificate_cleanup=NOT_CREATED`, `disposition=NO-GO`.
- Narrow corrective change: compute SHA-256 with `System.Security.Cryptography.SHA256` against file streams (with disposal), independent of PowerShell module autoload. All existing byte-for-byte comparisons remain mandatory. No signature, acceptance or distribution checks are bypassed.
- The new source contract prohibits reintroducing `Get-FileHash` in this standalone PowerShell subprocess.

## Fail-fast Windows host prerequisite check

- Added a read-only `ci-prerequisites.mjs` step **before** `cargo build --release`. It invokes the same noninteractive child `powershell.exe` mode as the bounded integration probe and verifies the PKI, Appx, certificate, JSON and Windows SDK prerequisites.
- The child check is capped at **20 seconds** and never creates a certificate, modifies a trust store, installs an MSIX, pairs a device or launches an agent.
- This prevents repeated expensive Rust builds when a required child PowerShell command is unavailable. Hosted preflight PASS is not a substitute for an actual MSIX installation or Store certification.
