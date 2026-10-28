# Tetherplane privacy policy — proposed, not yet effective

> **REVIEW DRAFT, 28 October 2026.** The maintainer must approve this document, identify the operator of any hosted public service and specify an authorized private contact before publishing it as an operative privacy policy. Source review is not a substitute for inspection of live infrastructure and retention settings.

## Scope and service operators

Tetherplane is free and open-source device-connectivity software. It supports local-only mode and optional operator-configured remote relay and OAuth identity services. The operator of each independently hosted relay, authorization server, reverse proxy, AI client or cloud service controls that service's records and must disclose its own privacy practices. One developer cannot promise uniform logging or retention for every self-hosted deployment.

This notice describes source-supported behavior, not an assertion that all installations are controlled by the project's maintainer.

## Categories of information processed

- **On-device state:** explicit allowed file roots, device IDs, credential files and settings; permitted filesystem, process, browser and desktop data during user-authorized operations; local audit or diagnostic state. File permissions do not guarantee encryption against other code running with the same user's OS privileges.
- **Pairing registry:** a relay can persist device ID, account ID, SHA-256 credential hash, pairing time and revocation time/status. Pending pairing challenges are held transiently. Revocation need not delete historical metadata or backups.
- **Authentication service:** the reference self-hosted OAuth/OIDC server uses persistent SQLite state for registered clients, grants, authorization codes, refresh tokens, interactions and sessions. A separately selected identity provider can process related identity information according to its terms.
- **Tool requests/results:** within locally granted permissions, requests and returned data can contain file paths or content, process output, browser page data and desktop observations. A relay terminating the MCP TLS connection **can observe those requests/results in transit**. This is **not generic end-to-end encryption between the AI client and the computer**.
- **Infrastructure and support:** third-party hosting/reverse proxies may process network metadata and access logs; optional diagnostic files or support submissions may contain details of the user's configuration. No universal claim of zero logging or zero telemetry has been established for all deployed components.

## Processing purposes and user choices

Information enables owner-approved pairing, authentication, permission checks, optional relay routing, requested AI client interactions, revocation and debugging where configured. Tetherplane's local stdio MCP mode does not require a remote relay. A configured AI client may itself send received information to its provider under that provider's separate policy.

A user or operator controls permitted filesystem roots and device policy, whether remote connectivity is configured, authorized clients and device revocation. Not every tool operation necessarily triggers a fresh interactive approval: enforcement follows the actual local policy. Do not disable Windows Smart App Control or other security controls as a workaround.

Operators must identify the destination of remote device data to the person authorizing it. Functionality that sends data to unselected services should not be silently enabled.

## Retention and deletion

- Pending pairing challenges expire (the reviewed relay registry defaults to ten minutes); account login proof records have shorter bounded validity.
- A configured relay state file persists device registry information. Revocation prevents subsequent authorization but can preserve the record with a revocation timestamp. This is **not** a promise of immediate complete deletion.
- The reference OAuth server stores state in SQLite, uses record expiry checks and supports grant revocation; the database, logs and backups can persist according to the real operator's configuration and backup schedule.
- Local device identity/state and some diagnostic information can survive agent exit or an ordinary uninstall. Installation documentation states that ordinary uninstall preserves state; explicit purge is a distinct operation.
- Concrete hosted-service retention periods, access-log configuration, subprocessors, privacy contact, backup disposal and deletion request procedure **must be verified for the deployed service before public adoption**. No universal retention period can be honestly specified from the repository alone.

Users should address revocation or deletion requests to the operator of the particular service hosting their information. Never post passwords, bearer tokens, OAuth credentials, personal files, or private support logs in a public issue.

## Third parties and security

Depending on configuration, data can reach the chosen relay host, identity provider, reverse proxy, AI-client provider and GitHub when users download files or submit reports. Review the corresponding operator's privacy policy. GitHub's own website and downloads are governed by [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

For the implementation's security model, see [remote-plane privacy and boundaries](docs/security/remote-plane.md), [threat model](docs/security/threat-model.md), [security reporting](SECURITY.md), and [installation/uninstallation guidance](docs/release.md).

## Contact and effective date — blocking owner decision

**Private privacy contact: PENDING OWNER APPROVAL.** The maintainer must confirm a reachable authorized private address or contact channel and whether any public Tetherplane-hosted service is operated by the maintainer. Do not publish a guessed email or name. The effective date is the date on which the approved policy actually becomes publicly operative, not the date this draft was written.
