# Tetherplane — Microsoft Store private-audience candidate (28 October 2026)

**Status: SOURCE CANDIDATE / RELEASE NO-GO.** No Partner Center upload, certification submission, trusted Store signature, public release, deployment, account change, or device mutation is authorized by this branch.

## Observed Partner Center product identity (owner screenshot)

| Manifest field | Exact value |
|---|---|
| `Package/Identity/Name` | `ARCUSLabs.Tetherplane` |
| `Package/Identity/Publisher` | `CN=6CCCFC81-2F0A-49BE-9027-A03BCF427F43` |
| `PublisherDisplayName` | `ARCUS Labs` |
| `Identity/ProcessorArchitecture` | `x64` |
| First submitted version proposed | `0.1.0.0` |
| Desktop minimum OS inherited from reviewed prototype | `10.0.22000.0` (Windows 11) |
| Resource language | `en-us` |

Partner Center owner reports an **Active Individual** developer enrollment with public publisher name **ARCUS Labs**, a reserved product name **Tetherplane**, private audience group **Tetherplane Internal Testers**, direct-link-only discoverability, and all required Store metadata sections complete except Packages and Store listing genuine screenshots. Group membership and region eligibility should be verified before delivery; publisher-name/account-policy eligibility remains a separate Partner Center review.

The product identity is taken from the owner's actual Product Identity screenshot, **not generated or inferred**. It is public package metadata; it is not an OAuth principal, a new relay account, a device credential, or an authorization grant.

## Strict branch isolation

- Branch `feature/msix-store-private-candidate-20261028` is stacked on accepted **draft** installer-preflight PR #71, pinned source HEAD `5cf428d3bf33e606db995c1e34749849711e91a8` at branch creation.
- New Store profile: `packaging/msix-store-candidate/AppxManifest.xml`.
- Existing disposable dev profile `packaging/msix-store-runtime/AppxManifest.xml` is **unchanged**, with independent synthetic publisher and `DevOnly` naming.
- The runtime still has **one owner setup app and one hidden native agent**, and retains `packagedClassicApp`, `mediumIL`, and the existing `runFullTrust` capability. No startup task/service/silent-launch capability has been added.
- No changes to OAuth/DCR client registration, account permissions, relay, Smart App Control, device identity state, Windows trust stores, or protected branches.

## Packaging modes

`scripts/msix-store/Build-StorePrivateCandidate.ps1` has two mutually exclusive modes.

**Disposable CI mode (`-CiValidationOnly`):** strict same-repository pull-request and hosted Windows runner guards; compiles the real reviewed `tetherd.exe`; uses signed/verified Node.js runtime and production Compact MCP dependencies; generates conspicuous **CI** test artwork; packs an unsigned MSIX with the **real reserved Store identity**; unpacks and verifies source hashes; immediately deletes its synthetic preview package. No package or app is uploaded, installed, executed on owner machines, certified, or signed; a JSON evidence report is the only retained artifact. This verifies structure and provenance **only**.

**Owner review mode (no `-CiValidationOnly`):** requires real files `Logo44.png` (44x44), `Logo50.png` (50x50), `Logo150.png` (150x150), and an explicit review/approval manifest whose SHA-256 hashes match all three. The owner approval record must name `ARCUSLabs.Tetherplane`. No fake placeholder/logo is allowed. The builder refuses to overwrite an existing output and creates an **unsigned candidate for review**, not a certified release. It never handles signing keys or submits packages. It emits a JSON provenance file in the payload and a separate report with exact source commit and native executable hash.

The script does **not** prove that Microsoft will certify the package or that Windows Smart App Control will admit the embedded native `tetherd.exe`.

### Owner artwork approval manifest

Use an external locally maintained JSON file *after selecting, reviewing and approving the genuine Tetherplane brand artwork*:

```json
{
  "schema": "tetherplane.store-approved-assets.v1",
  "package_identity": "ARCUSLabs.Tetherplane",
  "owner_approval_reference": "OWNER-SIGNED-REVIEW-REFERENCE",
  "files": {
    "Logo44.png": "64_HEX_CHARACTERS_FROM_ACTUAL_APPROVED_FILE",
    "Logo50.png": "64_HEX_CHARACTERS_FROM_ACTUAL_APPROVED_FILE",
    "Logo150.png": "64_HEX_CHARACTERS_FROM_ACTUAL_APPROVED_FILE"
  }
}
```

The example is deliberately invalid. Do not fabricate an approval reference, alter the expected hash or substitute the existing synthetic square drawings. The owner should approve these art assets before an unsigned release candidate is exported.

## Source-pinned Windows CI acceptance

- Check exact `ARCUSLabs.Tetherplane` identity, `ARCUS Labs` publisher, `en-us` language and Windows 11 x64 target.
- Prove no increase in existing application launchers, capabilities, startup, service registration, executable paths, or altered development publisher.
- Build production TypeScript/Compact MCP dependencies and real Rust `tetherd.exe` on disposable Windows; assert a signed Node.js runtime and Node LICENSE.
- Pack with Windows SDK MakeAppx, unpack, match SHA-256 of native executable, Node runtime, Store manifest, setup runtime, Compact MCP adapter and synthetic CI artwork.
- Record which exact checkout commit produced the candidate. A pull-request merge checkout SHA **must not be mislabeled** as the PR source branch head.
- Confirm preview is always `CI_PACKAGE_STRUCTURE_PASS_NOT_SUBMITTABLE`, and no MSIX file, private key, temporary signing certificate or device secret is uploaded.
- Independent current Windows/Ubuntu CI, Windows App Certification Kit, Microsoft Store validation and actual Store-signed install are separate gates.

## Remaining independently verifiable release gates

1. **Genuine branding:** approved Tetherplane emblem-only PNGs resized/cropped correctly, and actual desktop UI screenshots (minimum one; real app capture, no mock authentication or placeholder). Never upload the development square icons or fabricated success states.
2. **Publisher account compliance:** Microsoft Partner Center support confirmation that an **Individual** developer account may submit under existing **ARCUS Labs** public publisher name for the intended application. Do not create or replace a publisher account without owner approval.
3. **Store certification:** owner reviews final package provenance and approves any package upload and **private-audience** certification as separate actions. Microsoft signs MSIX after certification; a locally unsigned package is not installable as a trusted Store build.
4. **Smart App Control On:** trusted package acquired from Microsoft Store on owner-approved physical Leno, signed container and installed native `tetherd.exe` permitted to launch. A signed container is **not equivalent to an Authenticode-signed internal PE**. Record actual Code Integrity outcomes, app activation, and version/hash.
5. **Onboarding and rollback:** a clean, authorized user/device completes owner approval and authenticated `device.status` and scoped denial checks; prove reconnect, after-restart behavior, normal uninstall/state preservation and controlled rollback without disrupting the existing Leno Canary/old PID. Do not re-pair/revoke the existing Leno identity as a shortcut.
6. **Four-device acceptance:** independently verify required authorization boundaries and actual connectivity on Surface, Leno, VAULTER and separately authorized RTX. Passing PR CI is not evidence of this gate.
7. **Release decision:** no public release, protected merge, tag or marketing claim until gates have passed and owner explicitly approves.

Relevant Microsoft documentation:
- https://learn.microsoft.com/en-us/windows/apps/publish/get-started
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-certification-process
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages
- https://learn.microsoft.com/en-us/windows/security/threat-protection/windows-defender-application-control/manage-packaged-apps-with-windows-defender-application-control

**Technical release gate: NO-GO.** This document records a prepared source candidate, not a successful Store signing or physical-machine acceptance.
