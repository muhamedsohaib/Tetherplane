# Tetherplane code signing policy — SignPath Foundation application pending

> **REVIEW DRAFT, 28 October 2026.** SignPath Foundation has **not** accepted this project or signed any release in this review. This document authorizes no signing request, certificate registration, public release, Microsoft Store submission or protected-device installation.

## Program status

The maintainer intends to apply for free source-verifiable signing for eligible open-source Windows artifacts. **If the project is accepted and an eligible release is actually signed**, the required attribution will be:

**Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).**

This is a conditional program attribution. Neither [the existing Windows v0.1.0 release](https://github.com/muhamedsohaib/Tetherplane/releases/tag/v0.1.0) nor the development MSIX is represented as SignPath-signed.

## Authors, reviewers and release approvers

- **Repository owner and project maintainer:** [@muhamedsohaib](https://github.com/muhamedsohaib) at [muhamedsohaib/Tetherplane](https://github.com/muhamedsohaib/Tetherplane).
- **Authors/committers:** the maintainer and any further explicitly authorized contributors.
- **Reviewers:** the maintainer must review outside-contributor pull requests before signed-release inclusion. Existing branch protections and future approver permissions must be inspected and enforced, not assumed from this draft.
- **Signing approver:** the maintainer must manually authorize every request for the precise reviewed source and artifact; no automatic self-approval or delegated signing is asserted.

SignPath and GitHub MFA must be enabled for members with signing/source authority. Present MFA enrollment and SignPath roles are **not independently verified**.

## Required workflow before an eligible signed release

1. Identify an exact reviewed commit from the project's public source; review release scripts and open-source license compliance of bundled components.
2. Build a reproducible Windows release via a controlled GitHub Actions workflow; record commit, dependencies, version metadata, test results, file digests and release provenance. The source-to-artifact/signing pipeline is **not yet configured**.
3. Require independent integrity/security evaluation and explicit manual approval for each signing request. Preserve the signing service's artifact metadata rules and project-owned-binary restriction.
4. After SignPath accepts and signs an eligible binary, verify its actual Authenticode certificate and digest; evaluate Windows code-integrity / Smart App Control behavior without weakening protections; then run new-device authorization and rollback acceptance tests.
5. Publish only a separately approved and verified artifact with release-specific checksum, signer, source commit, scope and known limitations. No automatic release on success of unit tests alone.

The public tag release workflow currently **blocks new unsigned public Windows releases**. Do not remove or weaken this protection for convenience. A correctly signed executable does not guarantee SmartScreen reputation, Smart App Control acceptance, relay authorization, safe capabilities, or Microsoft Store certification.

## Privacy, uninstall and system permissions

Review the proposed [Tetherplane privacy policy](../PRIVACY.md), [remote-plane disclosure](security/remote-plane.md), [threat model](security/threat-model.md), [security reporting](../SECURITY.md), [release/installation documentation](release.md) and [recovery guide](recovery.md).

Tetherplane's local agent enforces policy, and a configured remote relay can observe MCP request/result data in transit. Users/operators must explicitly configure remote destinations and approve permissions. The per-user installer and ordinary uninstall are documented; ordinary uninstall can preserve device state, and intentional state purge requires a separate action.

## Activation blockers

SignPath acceptance; verified MFA and signing roles; project-owned eligible artifacts and dependency-licensing review; an approved **operative** privacy policy with a real private contact and accurate hosted retention; source-provenance workflow; manual signing approval; independent Windows acceptance; and owner authorization to publish.

Program terms: https://signpath.org/terms.html
