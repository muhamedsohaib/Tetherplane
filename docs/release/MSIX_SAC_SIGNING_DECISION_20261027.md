# Tetherplane — Smart App Control and Microsoft Store private-flight decision

**Date:** 2026-10-27. **Decision:** DEVELOPMENT VERIFIED / STORE RELEASE **NO-GO**. Based on draft PR #63 at `a6ec4b8cc4ed022b7d3d241091a59efaa874b6c6` and its disposable Windows G2 evidence. Does **not** grant permission for signing purchases, publisher registration, store submission, security-policy changes, or deployment to owner machines.

## Independently observed signing evidence (not inferred)

GitHub-hosted Windows MSIX test [Actions #40485121077](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40485121077), artifact `msix-store-runtime-g2-report-40485121077-1` (artifact ID `12725520495`), JSON checkpoint `2026-10-27T10:05:57.4335564Z`:

| Property | Recorded value |
|---|---|
| Bundled native Rust agent | `tetherd.exe` |
| Native agent SHA-256 | `4f4484fc57082bafb998daf7d981b90ebb4fc1793902da225523f6fe5cbb0b49` |
| Native agent Authenticode | **NotSigned** |
| Bundled Node runtime Authenticode | **Valid** |
| Test development MSIX signature | **PASS** |
| MSIX install, activated localhost UI, remove | **PASS** |
| Smart App Control enforcement check | **NOT_RUN** |
| Publisher identity | `CN=Tetherplane MSIX Development Probe` (**synthetic**, not publishable) |
| Release decision | **NO-GO** |

The artifact's `source_commit` field identifies GitHub's PR merge checkout, not necessarily the PR's head commit. The actual package manifest is development-only. The packaging trial is **not** the Microsoft Store signed package or a clean-device SAC On acceptance.

Microsoft's Store signs an approved MSIX **package**; Microsoft's Smart App Control guidance recommends assessing each loaded executable and script and not assuming package success equals trusted binary execution. It has **not** been verified whether the Store's package trust will be sufficient for this exact unsigned child PE on a target Windows 11 device. Do not claim signing the MSIX fixed Leno's original block; do not alter Smart App Control settings or suppress Code Integrity events.

Primary references:
- https://learn.microsoft.com/windows/apps/publish/faq/get-started-with-the-microsoft-store
- https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control
- https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control

## Release-critical minimum experiment

1. **Owner decision — publisher.** Confirm registered publisher account and whether publication should use a legal personal identity or a legally registered company. `Sohaib Labs` is a brand, not yet a verified legal entity. Microsoft does not support converting Individual to Company accounts. Do not automatically pick the wrong long-lived package identity.
2. **Owner approval — external action.** Reserve `Tetherplane` in Partner Center, retrieve the **actual** package Name/Publisher from App identity. Never guess or replace production OAuth/DCR identities. No application association or registration performed by this PR.
3. **Pre-publication candidate.** Rebuild reviewed source with the exact Partner Center identity, real approved icon/artwork, privacy/support information, accurate scope and `runFullTrust` restricted-capability rationale. No signing credential export, direct owner-device deployment or permanent startup registration.
4. **Private audience, not hidden-but-public.** Initial submission must be **Private audience**, with one or more known-user groups of **personal Microsoft accounts**, not work/school Entra accounts. Avoid accidental automatic conversion to Public audience. Certification is still required, even privately.
5. **Actual signed Store delivery.** On a new, owner-authorized Windows 11 machine with SAC **On**, install through the Store. Verify official signing, package identity and child `tetherd.exe` launch. Capture whether a CodeIntegrity **3077** event names the agent. Do not disable SAC or change registry security policies to force a pass.
6. **Owner-approved onboarding.** New identity only; request pairing, deny premature start, approve through the existing authenticated owner Control Center, verify real WSS, run six-tool discovery and `device.status`. Test unauthorized principal/file root denial, disconnect/reconnect, duplicate-instance prevention, revoke and clean uninstall.
7. **Release decision.** If native agent is blocked on SAC On, mark Store flight **FAILED**, investigate trusted executable signing independently and request owner approval before any paid certificate/Artifact Signing. No public release, no protected merge until passing clean-device evidence.

Source: https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/visibility-options

## Exclusions and branch separation

Draft #61's PowerShell MCP shim timeout and draft #64's diagnostics are **separate legacy installer** concerns. The Store prototype invokes its bundled signed `runtime/node.exe` directly via the manifest; the PowerShell pipe is not on that specific app activation path. Do not revise the four-device architecture to address it. Both PRs stay draft, with no deployment.

All owner machines remain unchanged. An installed package that shows a successful first-run page is not proof of an authorized, stable device. No production release without full acceptance and explicit owner approval.
