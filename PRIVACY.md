# Tetherplane privacy policy — proposed, not yet effective

> **REVIEW DRAFT, 28 October 2026 — not yet effective.** The independent maintainer has selected local/self-hosted-only public distribution and supplied a privacy-contact email. This document remains a proposed policy until final review and publication.

## Scope and service operators

Tetherplane is free and open-source device-connectivity software. Current public distribution is **local/self-hosted only**. The maintainer does **not** offer a public Tetherplane-managed relay, cloud, or account-hosting service to external users. Each independent operator decides whether to configure their own remote relay, OAuth provider, reverse proxy, AI client or host and remains responsible for the corresponding logging, backups, data protection, retention, and third-party disclosures.

The maintainer may operate private development infrastructure for the maintainer's own devices; this is not a public managed offering or a promise to process external users' data. A future Tetherplane-operated hosting service would require a separate, verified service privacy notice before external users could enroll. The software remains subject to each operator's configuration and authorization settings.

## Categories of information processed

- **On-device state:** explicit allowed file roots, device IDs, credential files and settings; permitted filesystem, process, browser and desktop data during user-authorized operations; local audit or diagnostic state. File permissions do not guarantee encryption against other code running with the same user's OS privileges.
- **Pairing registry:** a relay can persist device ID, account ID, SHA-256 credential hash, pairing time and revocation time/status. Pending pairing challenges are held transiently. Revocation need not delete historical metadata or backups.
- **Authentication service:** the reference self-hosted OAuth/OIDC server uses persistent SQLite state for registered clients, grants, authorization codes, refresh tokens, interactions and sessions. A separately selected identity provider can process related identity information according to its terms.
- **Tool requests/results:** within locally granted permissions, requests and returned data can contain file paths or content, process output, browser page data and desktop observations. A relay terminating the MCP TLS connection **can observe those requests/results in transit**. This is **not generic end-to-end encryption between the AI client and the computer**.
- **Infrastructure:** independent relay hosts, reverse proxies and other selected services may process network metadata and access logs; optional diagnostics may include device or configuration details. No universal promise of zero logging or zero telemetry is established for every deployment.
- **Voluntary privacy/support email:** when you email the project contact, the maintainer receives your sender address, message, associated metadata and any attachments. This mailbox is hosted through **Gmail (Google)**, whose systems process email under Google's own privacy terms. Emailing the maintainer does **not** automatically send data from your self-hosted device or relay; do not send credentials or unredacted logs.

## Processing purposes and user choices

Information enables owner-approved pairing, authentication, permission checks, optional relay routing, requested AI client interactions, revocation and debugging where configured. Tetherplane's local stdio MCP mode does not require a remote relay. A configured AI client may itself send received information to its provider under that provider's separate policy.

A user or operator controls permitted filesystem roots and device policy, whether remote connectivity is configured, authorized clients and device revocation. Not every tool operation necessarily triggers a fresh interactive approval: enforcement follows the actual local policy. Do not disable Windows Smart App Control or other security controls as a workaround.

Operators must identify the destination of remote device data to the person authorizing it. Functionality that sends data to unselected services should not be silently enabled.

## Retention and deletion

- Pending pairing challenges expire (the reviewed relay registry defaults to ten minutes); account login proof records have shorter bounded validity.
- A configured relay state file persists device registry information. Revocation prevents subsequent authorization but can preserve the record with a revocation timestamp. This is **not** a promise of immediate complete deletion.
- The reference OAuth server stores state in SQLite, uses record expiry checks and supports grant revocation; the database, logs and backups can persist according to the real operator's configuration and backup schedule.
- Local device identity/state and some diagnostic information can survive agent exit or an ordinary uninstall. Installation documentation states that ordinary uninstall preserves state; explicit purge is a distinct operation.
- Each self-hosted operator determines their own logs, backup schedules, third-party processors, access and deletion processes. Tetherplane does not operate a shared public customer-data service and cannot promise a universal retention period for independent installations.
- Voluntary privacy/support email remains in the maintainer's Gmail mailbox under the mailbox configuration and Google's policies. No fixed project-side auto-deletion period for emails is established. Send access or deletion requests to the privacy contact; handling may depend on the records and applicable obligations.

Users should address revocation or deletion requests to the operator of the particular service hosting their information. Never post passwords, bearer tokens, OAuth credentials, personal files, or private support logs in a public issue.

## Third parties and security

Depending on operator configuration, data can reach the selected relay host, identity provider, reverse proxy or AI-client provider; this is **operator-selected infrastructure**, not a Tetherplane-managed public hosting service. GitHub separately handles source browsing, downloads and issues under [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement). The privacy contact mailbox is processed by Google under [Google's privacy policy](https://policies.google.com/privacy).

For the implementation's security model, see [remote-plane privacy and boundaries](docs/security/remote-plane.md), [threat model](docs/security/threat-model.md), [security reporting](SECURITY.md), and [installation/uninstallation guidance](docs/release.md).

## Project privacy contact and effective date

**Privacy inquiries:** [muhammadsohaibsaif@gmail.com](mailto:muhammadsohaibsaif@gmail.com). This contact was supplied by the independent maintainer for public project privacy inquiries. For information held by an independently self-hosted operator, contact that operator rather than the repository maintainer.

**Effective date:** pending final maintainer approval and public policy publication on the protected main branch. This draft is not yet operative.
