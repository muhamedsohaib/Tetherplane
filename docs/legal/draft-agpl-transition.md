# DRAFT: Future AGPL-3.0-only + Commercial Licensing Transition

> Not an operative license grant. Do not copy into root LICENSE or announce as the current terms. Mandatory copyright-holder authorization and legal review remain outstanding.

## Proposed future branch/release boundary

- New, cleared original Tetherplane code: AGPL-3.0-only (SPDX identifier, subject to legal approval).
- Distinct signed customer alternative: separately negotiated commercial permission for precise components/versions where the licensor controls sufficient rights.
- Effective date, tag, licensor identity and version-to-file rights matrix: **TBD**.
- Historical commits and v0.1.0 remain available under their earlier MIT OR Apache-2.0 grants; old license notices cannot be withdrawn from copies already distributed.

## Precise protection model

AGPL allows commercial activity and private deployment. AGPL section 13 adds a corresponding-source offer for certain **modified AGPL programs** supporting remote network interaction. It is not a universal ban on proprietary use of all independent software that interacts with the program, and does not automatically require any unmodified server to disclose source simply because it is commercial. Exact boundaries for relay, agent, extension, plugins, process separation and linking require counsel.

Older MIT/Apache code remains legitimately usable commercially. A customer only gains value from a commercial alternative if it covers cleared new source, useful assurance/support, updates or other rights it does not already possess. Preserve third-party notices and permissions in either licensing path.

## Candidate text format for future new rights-cleared files (NOT APPLIED)

    SPDX-License-Identifier: AGPL-3.0-only
    Copyright (c) [accurate year(s)] [verified actual copyright holder(s)]

Use the verbatim official AGPLv3 text from https://spdx.org/licenses/AGPL-3.0-only.html only after legal signoff. Do not edit third-party file notices or label permissive third-party code as solely owned/AGPL-original.

## Proposed implementation map, contingent on gates

| Surface | Necessary implementation after approval |
| --- | --- |
| Root licensing | An effective-version clear LICENSE, official AGPL text, retained MIT/Apache and other required third-party notices, a license map/NOTICE as needed. |
| Rust workspace | Update eligible Cargo SPDX declarations; audit crates, deps, binaries, linking and distribution. |
| TypeScript packages/extension | Accurate per-package metadata, source headers, bundling and runtime dependency notices. |
| Relay/auth/server | Evaluate hosted modified-network source obligations and separate processes with counsel. |
| Packaging/installer | Include correct license and third-party notices in built Windows ZIP and installed tree, and test them. |
| README/CONTRIBUTING | Version-aware terms, source offer/access, lawful fork attribution, contributor commercial-grant policy. |
| Tests & CI | Tests first, valid SPDX map, notice preservation, compatible SBOM and real release smoke verification. |
| Trademark | Independently approved name/logo policy, not assumed from software copyright. |

## Mandatory deferrals

No source metadata changes, root license replacements, release/package rebuilds, distribution announcements, external contact, commercial prices, signature or tagging may occur until rights audit + legal signoff + owner final approval.

References: https://www.gnu.org/licenses/gpl-faq.en.html ; https://www.apache.org/licenses/GPL-compatibility.html ; https://github.com/github/opensource.guide/blob/main/_articles/legal.md .
