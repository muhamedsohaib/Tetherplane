# Tetherplane SignPath application and release-note packet — 28 October 2026

**NOT SUBMITTED.** Only use the application fields after the relevant draft documents have been reviewed and made available on the published main branch. An editable GitHub PR is not a public operative privacy policy.

## Evidence and limitations

- Public project: https://github.com/muhamedsohaib/Tetherplane (independent, open source, MIT OR Apache-2.0 per repository LICENSE, subject to bundled-license check).
- First released Windows ZIP: https://github.com/muhamedsohaib/Tetherplane/releases/tag/v0.1.0 (26 September 2026, ZIP plus SHA256SUMS). Windows acceptance and SignPath signatures are not established.
- Maintainer's merged Pollinations.ai open-source contribution: https://github.com/pollinations/pollinations/pull/15289 (28 September 2026). This documents contributor activity, **not** the Tetherplane project's user reputation.
- GitHub Actions: existing CI and Windows source packaging; no source-to-SignPath signing workflow, manual approval or project acceptance yet. New unsigned public release is deliberately blocked.
- Small GitHub asset-download counters do not establish unique users, installs, active use or third-party endorsements. SignPath's executable reputation rule may still prevent acceptance.
- **Confirmed by maintainer 28 October 2026:** public distribution is local/self-hosted only; no public managed Tetherplane relay or cloud service is offered to external users. The public privacy contact is **muhammadsohaibsaif@gmail.com**. Private development deployments are not a public hosted service.

## Application fields (after the privacy-policy gate)

| Field | Honest value |
| --- | --- |
| Project | Tetherplane |
| Website/repository | https://github.com/muhamedsohaib/Tetherplane |
| Download URL | https://github.com/muhamedsohaib/Tetherplane/releases/tag/v0.1.0 (must be updated to link to the approved code signing policy) |
| Privacy URL | https://github.com/muhamedsohaib/Tetherplane/blob/main/PRIVACY.md **only after approved and merged** |
| Wikipedia | Blank |
| Category | Developer Tools if the form offers it; otherwise closest relevant Utilities |
| Maintainer | Individual / independent developer |
| Build system | GitHub Actions (not yet SignPath-integrated) |
| First and last name | Owner enters their own legal name privately |
| Email | Owner enters preferred account email privately; public project privacy contact is muhammadsohaibsaif@gmail.com, which need not be the account login |
| Company | Blank if not applicable |
| Discovery channel | ChatGPT if available; otherwise Other |
| Exact source | Recommendation made during research into free OSS code signing for Tetherplane |

### Tagline

Secure, self-hostable device connectivity for AI agents through MCP, with owner-authorized access and local permission enforcement.

### Description

Tetherplane is a free open-source connectivity project for owner-authorized computer use by AI clients through MCP. It is currently distributed for **local and self-hosted deployment**, without a public managed Tetherplane cloud service. Its compact interface supports controlled file, process, browser and desktop operations. Local policy remains authoritative; optional operator-configured relays route authenticated requests to paired devices. Signing, clean-install Windows Smart App Control acceptance and Microsoft Store certification remain unfulfilled release gates.

### Reputation text

Tetherplane is an early-stage open-source project, with public code, a Windows v0.1.0 release, security and threat-model documentation, and GitHub Actions build/CI evidence. Its maintainer has a verified merged contribution to Pollinations.ai (https://github.com/pollinations/pollinations/pull/15289). The project cannot yet claim widespread independent adoption or signed-release certification. GitHub download counters do not identify successful installations or unique users. This application seeks SignPath Foundation's evaluation without claiming prior endorsement.

## Copy-ready addendum for the existing v0.1.0 release page

> **Code signing policy:** See [Tetherplane's code signing policy](https://github.com/muhamedsohaib/Tetherplane/blob/main/docs/code-signing-policy.md) and [privacy policy](https://github.com/muhamedsohaib/Tetherplane/blob/main/PRIVACY.md). The v0.1.0 ZIP predates the SignPath Foundation application and is **not represented as signed by SignPath Foundation**. Use the published SHA256SUMS to verify the downloaded file. A future eligible signed release will be announced only when actual signing and device acceptance are independently verified.

Retain original assets, SHA256SUMS and release history. Do not change release descriptions until the owner approves the disclosures and the public links actually resolve.

## Pre-submission gates

- [x] Maintainer confirms local/self-hosted-only distribution (no public hosted relay offered).
- [x] Maintainer supplies public privacy-contact email: muhammadsohaibsaif@gmail.com.
- [ ] Verify privacy mailbox is reachable, review any project-controlled telemetry and clarify private development infrastructure is not offered externally; approve final wording and effective date. Independent self-hosting operators control their own retention, backups and processors.
- [ ] Owner reviews and approves the privacy policy and signing policy. Confirm GitHub/SignPath MFA and precise signing/review roles.
- [ ] Check third-party binary redistribution and license compatibility; ensure software meets SignPath's restrictions on hacking/security bypass features.
- [ ] Merge through protected main after reviews; verify README and privacy-policy link live.
- [ ] Owner adds Code signing policy link to the existing download/release page; verify link is publicly accessible.
- [ ] Design and validate source-verifiable CI/signing artifacts, metadata restrictions and per-release manual approval; no credentials in GitHub or source.
- [ ] Owner personally supplies legal name, application email, terms/privacy consents and reCAPTCHA; marketing consent is optional. Only then submit.
- [ ] Independently verify any accepted SignPath-signed executable on a clean Windows SAC-On system before promoting downloads.

SignPath rules: https://signpath.org/terms.html

## Small evidence-building beta (not launched)

Invite 5–10 consenting technical users to a **separately approved** Windows test without disabling system security. Record only aggregate Windows version, SAC mode, launch allowed/blocked, pairing result, authenticated device.status, denied-operation result, reconnect and whether they would continue using Tetherplane. Never solicit device credentials, unredacted host logs or user files. Do not claim user adoption before verifying it.
