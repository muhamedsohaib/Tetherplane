# Tetherplane — Microsoft Store private-flight owner admission packet

**Revision:** 2026-10-27 (Asia/Dubai). **Status:** PREPARATION ONLY; **STORE SUBMISSION NO-GO**.
**Source:** open, unmerged, draft PR #65 `bfac56d1180aea3c165a8380c322919dd0971ec3`, stacked on draft PR #63, stacked on draft PR #60.
This document is public-source metadata preparation. It contains **no Partner Center credentials, legal identity details, secret tokens, real tester emails or approval**. It does not authorize sign-up, name reservation, publication, signing purchase, or changing installed clients.

## Exact evidence — development, not Store distribution

| Test | Result | Evidence |
| --- | --- | --- |
| GitHub Windows/Ubuntu general CI | PASS | https://github.com/muhamedsohaib/Tetherplane/actions/runs/40520315944 |
| Development MSIX unit, packaging and authenticated localhost relay tests | PASS | https://github.com/muhamedsohaib/Tetherplane/actions/runs/40520316192 |
| Installed MSIX native `bin/tetherd.exe` SHA verified and native CLI parser reached | PASS; expected exit 2 | artifact 12740987656, same run |
| Native EXE Authenticode | **NotSigned** | https://github.com/muhamedsohaib/Tetherplane/blob/feature/msix-store-runtime-20261027/docs/release/MSIX_SAC_SIGNING_DECISION_20261027.md |
| Leno October 27 Smart App Control blocked unsigned native agent | ENFORCED DENIAL, Windows Code Integrity 3077 | locally observed on Leno; separate installed Canary SHA, **not** this MSIX binary |
| Official Microsoft Store package signing | NOT RUN | No real publisher/app association |
| Real SAC On + clean authorised Windows 11 client | NOT RUN | No certified private-flight package |
| Real owner-approved WSS / 4-device acceptance / revoke / rollback | NOT RUN | CI localhost relay does not establish production acceptance |

The CI test MSIX was temporarily signed with a synthetic development certificate and removed from its disposable Windows runner. Never repurpose it as a customer installer or assume a package signature proves all child binaries trusted.

## A. Publisher account — human-owned identity gate

**Owner-selected product/publisher naming (October 27, 2026):** The Windows Store **publisher display brand is ARCUS Labs**, and the application/product is **Tetherplane**. This supersedes the earlier instruction that the public-facing **Published by** field must display Tetherplane. The owner provided a Partner Center screenshot showing the chosen ARCUS Labs publisher display in an active account. For privacy, the public repository does **not** reproduce account-type/legal-contact screenshots, seller IDs, personal information or verification numbers.

**Compliance boundary:** A display name is not proof of a registered legal organization or a Microsoft-approved Company publisher. Microsoft Store Policy 10.14 (effective October 22, 2026) can require a Company account where a reasonable consumer would interpret an app or publisher name as a business entity. The owner-reported account is classified as **Individual** in Partner Center; existing account status alone does not establish that professional/business-facing release under ARCUS Labs meets this policy. Do not mislabel the account as Company, fabricate a registered entity, attempt to change the developer account type, or submit for certification before checking eligibility with Microsoft. The exact MSIX Publisher subject/package identity must come from the **Tetherplane Product identity** screen after reservation; **ARCUS Labs** as a public-facing brand must not be substituted for a cryptographic publisher string.

**Remaining admission decision:** Product-name availability may be checked without commitment. Reserve under this account only after considering whether the intended publisher account can lawfully hold and publish the product; changing developer account type from Individual to Company is unsupported. No Store submission or public publication is authorized.

Publisher naming references:
- https://learn.microsoft.com/en-us/windows/apps/publish/store-policies (section 10.14)
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-additional-information (Published by field)


Microsoft's current guidance:
- Both Individual and Company accounts can be registered through the current free onboarding experience; eligibility and verification are determined by Microsoft.
- An **Individual** account publishes under a legal person's name; Microsoft's guidance describes this path for work *not related to a business, trade or profession*.
- A **Company** account is Microsoft's stated path for independent developers/freelancers distributing apps in relation to their trade or profession, as well as registered organizations. Publisher business verification requires appropriate official business evidence (such as a license/registration or DUNS number) and a suitable organization-domain work email. A brand name alone is not verification of a legal entity.
- Changing an existing Individual Partner Center developer account into a Company account is **not supported**. Do not enroll the wrong irreversible publisher type merely to make the package pass.
- Do not put legal identity documents, private account email, ID numbers, payment details or screenshots containing PII into this public repository.

**Owner action when authorised:** In the existing Partner Center account, open **New product → MSIX or PWA app** and check availability for `Tetherplane`. Do not commit the reservation, create a new developer account, or submit a package until the policy 10.14 publisher eligibility and intended account ownership are resolved. Record the reservation and Product identity privately once confirmed. Preserve existing OAuth/DCR clients and all real device identities.

Record **privately**, not here: whether registered, account type, reserved product name, actual Package/Identity **Name**, **Publisher**, package family name (if available), and Partner Center product ID. An agent may compare those public package identity strings to the manifest but cannot authenticate their provenance from a pasted JSON string alone.

References:
- https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission
- https://learn.microsoft.com/en-us/windows/uwp/publish/manage-app-names

## B. Private Store audience — mandatory initial scope

After an owner-approved **draft** submission is prepared, the intended audience is **Private audience**, not Public audience with search discoverability disabled. Use a known-user group of **personal Microsoft accounts**; work/school Entra accounts cannot acquire private Store apps. The availability of a genuine approved tester account is not verified. Do not publicly distribute this experimental package.

Important: Microsoft says a product initially submitted to a Public audience cannot later be changed to Private audience. Before any certification submission, independently inspect the selected audience, markets, package version, publisher, and whether the default publish-as-soon-as-certified option has been replaced with an owner-approved hold as appropriate.

Reference: https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/visibility-options

## C. Draft Store listing (not approved for publication)

**Product name:** Tetherplane (subject to verified reservation).

**Public publisher brand:** ARCUS Labs (owner-selected; exact Partner Center Product identity and Microsoft policy 10.14 acceptance not yet verified for certification).

**Short description (provisional):**
Tetherplane connects an authorized Windows device to an owner's AI tools through an explicit pairing and access-control workflow.

**Long description (provisional, subject to actual Store-build acceptance):**
Tetherplane is an open-source device connectivity tool designed to keep the owner in control of which devices and capabilities an AI client can access. A new Windows device requests pairing; the owner approves it through an existing authenticated Control Center. The Windows agent uses device credentials and the configured relay, and available operations are restricted by the device's authorized policy. The product is not intended to provide unrestricted access to a computer.

The app requires the owner's existing Tetherplane relay and a compatible authenticated client. Remote access, browser automation, local files and process-related capabilities are conditional on configuration, grants and supported platform behavior. Do not describe unsupported capabilities as available to every user.

**Publication blockers:** exact final scope/capability mapping, trustworthy UI screenshots and branding, accessible real support channel, approved public privacy-policy URL, actual onboarding instructions, verified handling of diagnostics/telemetry and retention, final permissions disclosure, accessibility and clean-device release testing. Do not invent a privacy URL or make unverified claims of encrypted storage or Store approval.

## D. Proposed restricted `runFullTrust` capability explanation (review required)

> This Windows packaged classic application bundles a medium-integrity native Windows agent (`tetherd.exe`) and a Node.js setup interface. `runFullTrust` is required because the explicitly user-started native agent performs owner-authorized desktop/device operations not available in the sandboxed application model. The application requests a new device pairing code, requires approval by the existing authenticated Tetherplane owner, and uses device-specific authorization rules and a user-chosen filesystem root. The package does not install a privileged Windows service, request elevation, modify Windows security policy, or auto-register a startup task. Features are unavailable until the owner has approved the device and appropriate capability grants exist. A separate clean-device validation must confirm these statements before submission.

This is source-based proposed certification text, **not** a Microsoft approval. Review carefully against the exact final package. A Store certifier must be able to exercise a safe, permitted test environment without production credentials.

References:
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations
- https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options

## E. Release admission gate — all required for GO

- [ ] ARCUS Labs public publisher brand confirmed under an eligible Partner Center account; Microsoft Store Policy 10.14 account classification resolved for intended distribution.
- [ ] `Tetherplane` product name reserved and **actual** App identity/Publisher copied from Partner Center; do not reuse synthetic `Tetherplane.StoreRuntime.DevOnly` identity.
- [ ] Exact Partner Center identity and package version agree with release manifest, source/build provenance is recorded, signed Store-delivered MSIX verified.
- [ ] `runFullTrust` declaration and truthful supporting certification notes approved; no new unreviewed restricted capabilities.
- [ ] Verified public privacy/support URLs, approved logo and representative screenshots; actual data collection, secret protection (Windows ACL/DPAPI or equivalent) and retention behavior reviewed.
- [ ] Build contains no development-only placeholder identities, credentials, synthetic certificates, unsafe ACL modifications or silent auto-start.
- [ ] Install the **genuine** private-flight Store package on a **new**, specifically authorised Windows 11 device with Smart App Control already On; never change SAC mode to force a pass.
- [ ] Verify package signature, installed Rust PE launch, no new `3077` block, expected Start-menu/UI behavior and actual user input.
- [ ] Owner approval flow, real TLS WSS relay handshake, six-tool MCP discovery, authenticated device status, file-root allow/deny, wrong-account denial and revocation tested independently.
- [ ] Single instance, user-consented background lifecycle, reboot/disconnect recovery, uninstall/rollback and preservation of Leno/Surface/VAULTER/RTX installations/identities independently verified.
- [ ] Review exact GitHub merged ancestry, CI source commit and artifacts; secure code review completed; user separately approves protected merge and private submission.

**No-GO on any missing gate.** Keep current PRs draft, production untouched and existing four-device architecture unchanged.

Primary reference: https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control
