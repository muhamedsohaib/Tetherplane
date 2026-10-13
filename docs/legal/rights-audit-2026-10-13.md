# Tetherplane Preliminary Rights Audit — NOT LEGAL CLEARANCE

Observation date: 2026-10-13. Main snapshot: 5feee084eb24bfd4831ab42840bb5f10dafc8113. Sources: GitHub repository API, main Git tree, commit log, fetched manifests/files, release assets and indexed GitHub search. The canonical Leno computer was offline; a local full-source or compiled-distribution scan was not performed.

## Confirmed baseline

| Evidence | Observation | Limitation |
| --- | --- | --- |
| LICENSE and LICENSE-MIT / LICENSE-APACHE | Root license offers MIT OR Apache-2.0. MIT notice reads 'Copyright (c) 2026 Tetherplane contributors'. | Attribution text alone does not prove the legal owner. |
| Root Cargo.toml | workspace.package.license = 'MIT OR Apache-2.0'; Rust member crates inherit workspace license. | No future SPDX migration has been applied. |
| Workspace JS packages | Ten internal package manifests examined; declared private and no explicit license field. | Absence of a field does not erase repository-level licensing. |
| Git tree | 437 entries, with three root license files; no independent project NOTICE or SBOM file found by filename scan. | Not a full copyright/license scan. |
| Git commit log on main | 268 commits: 181 associated with muhamedsohaib, 87 with Tetherplane Automation. | Git authorship does not prove ultimate ownership; this excludes unmerged branch-only commits. |
| Indexed GitHub source query | No indexed SPDX-License-Identifier matches. | Not proof all source lacks notices; full search needed. |
| Windows build scripts | scripts/package-windows.ps1 and scripts/install-windows.ps1 copy LICENSE-MIT and LICENSE-APACHE. | Current packager does not copy the umbrella root LICENSE; future notice distribution requires review. |
| Release v0.1.0 | Public Windows-x64 ZIP and SHA256SUMS, released 2026-09-26. | Old binary licensing remains historically significant; download counters cannot identify cloners. |

Sources: https://github.com/muhamedsohaib/Tetherplane/blob/main/LICENSE ; https://github.com/muhamedsohaib/Tetherplane/blob/main/Cargo.toml ; https://github.com/muhamedsohaib/Tetherplane/releases/tag/v0.1.0 ; https://github.com/muhamedsohaib/Tetherplane/blob/main/scripts/package-windows.ps1 .

## Unresolved rights questions — all BLOCKING

- [ ] Verify who holds copyrights for every copyrightable source, documentation, generated file and asset; review employment, contractor, assignment and joint-work agreements.
- [ ] Check main, release tags and all feature branches for outside contributors and source material, not just GitHub author labels.
- [ ] Trace automation/AI-authored material and imported snippets for origin, protectability and applicable third-party license requirements; review with counsel.
- [ ] Audit third-party and transitively bundled material from Cargo.lock, pnpm-lock.yaml, npm deploy stages, extension build and actual Windows ZIP, including asset/fonts if any.
- [ ] Produce an SBOM and license-compatibility matrix; identify restrictions relevant to AGPL and any separate proprietary commercial grant.
- [ ] Determine the legal licensor and whether contributors have granted sufficient rights for *both* AGPL publication and alternative commercial licensing.
- [ ] Retain historic MIT/Apache copyright/notice obligations for permissively licensed components incorporated into a future distribution.
- [ ] Confirm Tetherplane wordmark/logo ownership and relevant trademark searches; no registration is verified.

## Legal significance

Compatible permissive material may be included in an AGPL-covered combined release with its existing notices and requirements. That does not remove earlier MIT/Apache rights. Ownership of every original component is not established from commit metadata alone. A separate proprietary commercial license may require additional grants or rights exclusions. A DCO signoff is not automatically a commercial relicensing authorization.

## Required fresh verification

When Leno is online, first verify git status, branch, last five commits and remotes, then run complete author/file/license inventory in the canonical working copy. Audit the staged Windows release ZIP and record exact tool versions, source SHA, evidence timestamps and open questions. Do not substitute another computer without express authorization.

Current disposition: **preliminary evidence only; release blocked**.

## Owner statement and expanded technical review (2026-10-13)

The user has stated personal ownership and no known employer/client/contractor/third-party claims. Record this as a **self-report only**; no signed rights or contracts were independently reviewed. An extended audit also examined the more recent 661-commit development branch, the same 191 external Rust and 179 pnpm lockfile entries, and Windows packaging gaps. See [technical audit](technical-audit-2026-10-13.md) and [machine-readable lockfile inventory](lockfile-inventory-2026-10-13.json). This does not constitute legal or licensing clearance.
