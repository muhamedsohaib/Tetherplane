# Tetherplane v0.1.0 release-artifact license inspection

> **NON-OPERATIVE EVIDENCE REPORT — NOT LEGAL CLEARANCE.** This report describes a historical MIT OR Apache-2.0 release, not permission to relicense or publish a new version. Prepared 2026-10-13. No released artifacts or operative licenses were modified.

## Provenance and checksum

- Canonical repository: https://github.com/muhamedsohaib/Tetherplane
- Historical public release: https://github.com/muhamedsohaib/Tetherplane/releases/tag/v0.1.0 (published 2026-09-26).
- Original GitHub Actions **Release** run: https://github.com/muhamedsohaib/Tetherplane/actions/runs/36235615108
- Original run artifact: `Tetherplane-Windows-x64`, artifact ID `10903524466`; an outer Actions ZIP was downloaded through the authenticated GitHub connector and contained `Tetherplane-Windows-x64.zip` and `SHA256SUMS.txt`.
- Historical release ZIP size: **13,586,021 bytes**.
- SHA-256 measured from the recovered release ZIP: `c909cdd78ac786ea2bcb4853841db9d52928c8ae54a99e3306c945aba1066e9c`.
- This SHA matches **both** the historical GitHub release asset's API `digest` value and the archived `SHA256SUMS.txt` content.
- `manifest.json` identifies `source_commit: 3322260f294e98fc61fc45166e07de067c0cca36`, `version: 0.1.0`, Windows x64, Node runtime required, and the six MCP tools.
- ZIP CRC was fully verified with Python `zipfile.testzip()`; no corrupt entries or path traversal names were detected. Binary code was **not executed**. The archive was examined in a temporary sandbox only; GitHub/Leno remain canonical.

## Artifact-level inventory

| Measured contents of historical Windows ZIP | Count |
| --- | ---: |
| ZIP entries | **7,514** |
| Uncompressed total bytes | **42,023,051** |
| License/notice-like filename entries | **189** |
| `package.json` entries, including nested package/dist metadata | **224** |
| Real `node_modules` package installations with name/version | **190** |
| Unique installed Node package name/version combinations | **95** |
| Third-party Node package installations | **187** |
| Internal `@tetherplane` workspace package installations | **3** |
| Rust executable files | **1**: `bin/tetherd.exe` |

For the **187 third-party Node package installations**, all had a license declaration in their own `package.json` and a license-file candidate in that package's directory. Distribution metadata breakdown, **per installation rather than unique package**, was:

| Declared license | Installed instances |
| --- | ---: |
| MIT | 167 |
| ISC | 14 |
| BSD-2-Clause | 2 |
| BSD-3-Clause | 4 |

No installed third-party Node package declared GPL/AGPL/LGPL under this artifact-only parsing pass. This does **not** independently validate the package copyright holders, license text contents against SPDX, source of each compiled/bundled file, JavaScript build provenance, or rights for future proprietary dual licensing.

Three internal bundle instances lacked a package-level `license` field and nearby license file: two installations of `@tetherplane/protocol@0.1.0` and one `@tetherplane/compact-mcp@0.1.0`. The ZIP does carry the project-root MIT and Apache license texts, and README refers to both; treating internal-package metadata as a future clarity improvement is appropriate, **not as proof of noncompliance**.

## Root and other notices

- Present in ZIP root: `LICENSE-MIT` and `LICENSE-APACHE`.
- Absent in ZIP root: umbrella `LICENSE`, consolidated `NOTICE`, and a `THIRD-PARTY-NOTICES` file.
- All 189 license/notice-like files found by filename are accounted for by the 187 third-party Node package installations and the two project license texts.
- **Important unresolved area:** the executable `bin/tetherd.exe` may statically include Rust components. The lockfile has **191 external Rust crate entries**, but the ZIP does not offer an explicit per-crate notice manifest. Actual linked crates, their license texts, attribution obligations and applicable binary-release notices must still be verified against a real build and registry/source audit.
- The release package contained two existing project licenses and 187 third-party Node license texts. Lack of an umbrella LICENSE/NOTICE is an evidence flag, **not a legal conclusion or automatically a violation**.

## What the review does and does not establish

**Established:** Public release artifact integrity, package structure, installed Node package license declarations and adjacent files, old project licenses present, no executable launched, no license modifications.

**Not established:** Complete Rust binary dependency composition, all npm transitive notice sufficiency under applicable law, actual copyright rights of original authors, compliance with optional patent/attribution terms, AGPL compatibility or lawful alternative commercial licensing authority. The bundled Node inventory differs from the `pnpm-lock.yaml` lockfile's 179 potential package entries because it is an actual multi-package deployment with duplicate installations and platform/development filtering; do not equate these counts.

## CI observation separate from licensing

The existing CI on `feature/license-protection-proposal-20261013` failed on both ubuntu-latest and windows-latest at Rust Clippy using Rust **1.99.0**. The recorded lint is `clippy::assert_is_empty` at `agent/providers/search/src/search_tests.rs:214` and `agent/providers/process/tests/process.rs:385`. The identical `main` code had this issue; the licensing branch's diff to main was only `docs/legal/**` at that point. Thus this **is not evidence of a licensing change failure**, but full-repository gates are currently red and must not be represented as passing.

See https://github.com/muhamedsohaib/Tetherplane/actions/runs/38447815478 . Any non-licensing Rust Clippy fix should be a separate tested implementation task/branch.

## Required follow-up before any new AGPL release

1. Confirm the exact historical binary linked-crate graph and inspect required Rust component licenses/NOTICE files. Generate release-derived SBOM (SPDX or CycloneDX) and license matrix from a reproducible build, including Windows-specific dependencies and staged output.
2. Validate exact registry license metadata for 191 Rust crate entries and 179 pnpm package entries (including development/platform filtering); resolve anything ambiguous with source text and counsel.
3. Validate root `LICENSE`, third-party attribution and source-offer behavior for a **future** rights-cleared AGPL package in tests before implementing the changes; preserve historical licenses and releases.
4. Complete all-branch contribution/ownership provenance review and obtain legal approval to make both AGPL and separately negotiated commercial grants.
5. Run fresh tests/build/package gates on Leno after it becomes available. Do not touch any alternative device to substitute for Leno.
6. Obtain separate owner approval for any operative license, merge, new version, external outreach or release.

This is an audit of a historic binary. No finding establishes that another party has copied the project, that existing commercial use is prohibited, or that a prospective AGPL license is in force.
