# Tetherplane — Microsoft Store private-audience candidate (28 October 2026)

**Status: SOURCE CANDIDATE / RELEASE NO-GO.** No Partner Center upload, certification submission, trusted Store signature, public release, deployment, account change, or device mutation is authorized by this branch.

## Observed Partner Center product identity (owner screenshot)

| Manifest field | Exact value |
|---|---|
| `Package/Identity/Name` | `ARCUSLabs.Tetherplane` |
| `Package/Identity/Publisher` | `CN=6CCCFC81-2F0A-49BE-9027-A03BCF427F43` |
| `PublisherDisplayName` | `ARCUS Labs` |
| `Identity/ProcessorArchitecture` | `x64` |
| First Store MSIX package version proposed (not yet uploaded) | `1.0.0.0` |
| Desktop minimum OS inherited from reviewed prototype | `10.0.22000.0` (Windows 11) |
| Resource language | `en-us` |

Partner Center owner reports an **Active Individual** developer enrollment with public publisher name **ARCUS Labs**, a reserved product name **Tetherplane**, private audience group **Tetherplane Internal Testers**, direct-link-only discoverability, while Pricing, Properties and Age ratings were shown Complete. Packages are Not started, and the English Store listing (including its required description and genuine screenshot) was not confirmed saved. Group membership and region eligibility should be verified before delivery; publisher-name/account-policy eligibility remains a separate Partner Center review.

The original `0.1.0.0` Store-package version proposal was corrected to `1.0.0.0` for Microsoft Store four-part package-version admission (nonzero major, reserved fourth component `0`). This changes **only the proposed MSIX package version**; it does not rebrand Tetherplane, change the application/runtime's `0.1.0` version, change the existing reserved Package Name/Publisher, modify a Partner Center submission, or claim a certified package. Before any submission, independently verify the exact version shown in Partner Center; no package was uploaded in this branch. See https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/package-version-numbering .

The product identity is taken from the owner's actual Product Identity screenshot, **not generated or inferred**. It is public package metadata; it is not an OAuth principal, a new relay account, a device credential, or an authorization grant.

## Strict branch isolation

- Branch `feature/msix-store-private-candidate-20261028` is stacked on accepted **draft** installer-preflight PR #71, pinned source HEAD `5cf428d3bf33e606db995c1e34749849711e91a8` at branch creation.
- New Store profile: `packaging/msix-store-candidate/AppxManifest.xml`.
- Existing disposable dev profile `packaging/msix-store-runtime/AppxManifest.xml` is **unchanged**, with independent synthetic publisher and `DevOnly` naming.
- The runtime still has **one owner setup app and one hidden native agent**, and retains `packagedClassicApp`, `mediumIL`, and the existing `runFullTrust` capability. No startup task/service/silent-launch capability has been added.
- No changes to OAuth/DCR client registration, account permissions, relay, Smart App Control, device identity state, Windows trust stores, or protected branches.
- The existing onboarding application's source deliberately remains in **development-preview** mode. The Store candidate packaging script makes deterministic, exact-once changes **only in a scratch payload copy**: new `TetherplaneStore` local state directory (not `TetherplaneStoreDevOnly`), a truthful Store customer-facing setup title/banner, and an explicit statement that no previous agent or credential is automatically replaced. Any upstream UI or state-path drift fails packaging rather than silently shipping obsolete strings. CI verifies the unpacked JavaScript and HTML and executes the packaged runtime's credential-free `--self-test`.
- This state-path distinction is not a supported migration from an old device identity; Leno's existing task, PID and credentials remain untouched. A migration/rollback workflow requires separate user authorization and proof.

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

## Independent pre-certification audit — 28 October 2026

This is a **source review, not a certification result**. PR #72 was observed at branch HEAD `f85998a6007b8ab6c52997f20fb2b3ed4f15835d` when the following evidence was retrieved. New commits require their own exact-head CI verification; the GitHub Actions pull-request merge checkout is not the branch HEAD.

### Retained build evidence (source checkpoint above)

- GitHub Store packaging run [40611958564](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40611958564): source-contract and windows-source-package passed.
- General CI [40611958512](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40611958512): release policy, Ubuntu quality and Windows quality passed.
- Store runtime G2 [40611958545](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40611958545): all jobs **skipped**, not an installed-app proof.
- JSON-only evidence artifact [12783652453](https://github.com/muhamedsohaib/Tetherplane/actions/runs/40611958564/artifacts/12783652453); ZIP SHA-256 `42e39cdf4beabeeb6c6dea79548507eef41d8e47dec4b55ba048b26300e5c995`. Scheduled to expire **4 November 2026 01:01 UTC**. This record may be retained as textual evidence; do not archive or distribute the synthetic MSIX.
- JSON `source_commit=9730dd6d86f5b054626e5eb0bf48d4c8cb3108b4` identifies the **GitHub Actions PR merge checkout**, not the reviewed branch SHA.
- Build payload checksums: agent `2f430a4e19e1bff906bf03a2fdf394ef58f96c001830bc56198136298d17ed5f`; Node `dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f`; Store manifest `bb98405e10903ffeefe77c52303154c134ac5527747eb670ab9b280759f337e8`; staged UI `0585b5bc3e3cea5204f9d2acbc03ed2fa5eccf7693d042af22e35c894fce0e89`; staged runtime `42bd3651047f3f2306f63f390693825f2b6d928542f6627cccc3c5531ba93ad0`.
- Synthetic, **destroyed** CI-preview MSIX SHA-256 `08a90c5e760b58b3684ecd802889b7fac324b63abd5bfe695d11f81a5f8ebcc1`; disposition `CI_PACKAGE_STRUCTURE_PASS_NOT_SUBMITTABLE`. Native Authenticode: `NotSigned`; trusted Store signing: `NOT_RUN`; Smart App Control On: `NOT_RUN`. No actual Store package is available for owner installation.

### Authentic brand-source and screenshot gate

The already-approved black/crimson geometric design was visually identified in the user's Tetherplane Project Library: **`/Tetherplane/Tether Plane Minimal Logo.png`** (1254 × 1254 PNG, 18 October 2026, includes a wordmark), and the emblem-containing `/Tetherplane/Tether Plane Logo Emblem.png` (1418 × 1109 PNG). These legacy Library entries could be previewed but did not permit raw-byte export in this review. **No approved PNGs, SHA-256 approval manifest or finished Store artwork were fabricated.** Obtain the source file with intact bytes, crop to the approved emblem only by mechanical operations, preserve shape and crimson color, and inspect 44×44, 50×50 and 150×150 on dark and light surfaces. Ask owner to approve final asset hashes before owner-mode packing. Separate Store listing assets may require additional sizes.

The real onboarding UI is currently served by the packaged Node runtime to an **actual loopback browser window**; it is not a native standalone wizard. Genuine UI states visible in source: (1) initial unpaired relay/device/access-root form, (2) owner-approved pairing challenge (sensitive code: do not publish), (3) saved identity/resume, (4) failed saved-state ACL recovery, and (5) `agent_started_not_verified`. Do **not** present any of these as authenticated connectivity. Capture the initial unpaired form on an explicitly authorized disposable Windows installation, at real desktop screenshot resolution **at least 1366×768 PNG**, with no user path, loopback URL fragment token, device identifier, relay endpoint, live pairing code, or account details exposed. Keep the image genuine: crop/redact sensitive browser chrome without inventing any UI or connection state. A source-rendered mockup is not acceptable for the Store listing. If packaging or installation is not authorized, screenshots remain blocked.

### Policy, privacy, capabilities and operator export

- **Policy 10.14 — Account type**: Microsoft Store policy requires company enrollment where a reasonable consumer would interpret the developer/publisher/application name as a business. Current **Individual** enrollment with public **ARCUS Labs** publisher creates a material eligibility question. Obtain written Partner Center policy clarification or an owner-approved compliant account strategy **before submission**; do not silently change account or replace product identity. Policy: https://learn.microsoft.com/en-us/windows/apps/publish/store-policies .
- **Restricted `runFullTrust`**: provide an accurate Store submission justification: a user-authorized local classic-app Rust agent handles bounded local files/processes, with on-device policy and no automatic startup. No new capabilities are requested.
- **Privacy/contact**: independently verify a reachable public privacy URL, authorized support contact, actual relay visibility, operational logging, retention and deletion disclosures, credential-state ACL behavior, and policy scope. Never add a personal phone number or email to public listing without owner approval.
- **Operator mode failure safety**: previously owner-mode packing wrote to final `.msix` before all validation; an unsuccessful later check might leave a seemingly distributable file. The targeted review correction stages operator packages in a private temporary directory, validates unpacked payload/self-test/hashes/provenance, then copies to a random CreateNew temporary file in the destination directory, verifies the copy checksum, and atomically moves it to a new owner output path without replacing an existing file. CI synthetic mode remains discard-only. This is source/CI tested; no owner-approved or trusted physical install is implied.
- **Windows compatibility**: manifest is x64, `Windows.Desktop` Windows 11 minimum `10.0.22000.0`; it does not support Windows 10. Confirm target device OS version before owner testing. The packaged entry point, command-line activation, launch identity and native code integrity have not been verified on a clean physical Windows installation.

### Restricted private-audience trial — separate permission gates

1. Owner checks Partner Center still says **Private**, group **Tetherplane Internal Testers**, direct-link only, no automatic public availability, pricing Free, and confirms group membership, audience regions, privacy URL, policy eligibility and saved listing status.
2. Obtain owner approval for the real logo file hashes, native agent signing strategy, output package provenance, and separately for any **Store upload/certification**. Run Store package validations/Windows App Certification Kit on the approved candidate before submission.
3. After Store certification, obtain explicit separate approval for a physical SAC-On trial. Record old Leno process, current executable hash, scheduled tasks, Code Integrity baseline and the **presence and ACL** (never contents) of existing state. Test a newly authorized clean device first where practical. Do not replace canary tasks or old identity.
4. Acquire the **Microsoft-distributed, trusted-signed** exact package and verify activation, native agent allowed to start without disabling SAC, owner approval, authenticated client `device.status`, permitted workflow, disallowed capability and filesystem denial, reconnect/reboot and no foreground takeover. Do not count a successful UI launch as authenticated connectivity. Track package and PE signer/hash, Code Integrity events and exact agent version.
5. **Rollback**: stop only the new approved package-owned agent/process; uninstall only the new package after authorization; preserve prior dev/canary scheduled tasks, old agent PID/path where possible, existing credentials and rollback state; independently recheck old connectivity. Never delete or re-pair another identity to force success. Only proceed to other three protected devices under their own authorization.

**Release decision: NO-GO.** Authentic source bytes, screenshot, Store publisher/account eligibility, full-trust justification, finalized privacy/support metadata, approved signing/submission, Store-certified distribution and real-device acceptance remain unfulfilled. No code-signing, installation, protected-branch merge or release is authorized by this review.
