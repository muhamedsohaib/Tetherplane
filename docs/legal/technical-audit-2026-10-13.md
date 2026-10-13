# Technical rights and dependency audit — 2026-10-13

> **NON-OPERATIVE, PRELIMINARY AND NOT LEGAL CLEARANCE.** No replacement of MIT OR Apache-2.0, no license publication, no contributor agreement, no commercial contract and no release authorized. The project owner has stated personally held ownership with **no known** employer/client/contractor/outside-party rights claims. This is a self-report, **not** an independent ownership or employment-contract verification.

## Scope and evidence

- Canonical: [muhamedsohaib/Tetherplane](https://github.com/muhamedsohaib/Tetherplane), GitHub source/API and direct lockfile parsing.
- Main HEAD: `5feee084eb24bfd4831ab42840bb5f10dafc8113` (latest main history dated 2026-09-29).
- Newer candidate inspected: `feature/live-acceptance-preserve-state-20261013` at `1dc56dde11a7c4ea593ad709dbfb2050cf025762`.
- Audit time: 2026-10-13; Leno reported **offline** via Remote Desktop Commander. No Leno checkout, build, full extracted dependency source, security scanner, or actual Windows ZIP inspection was performed. Temporary public clone attempt in container failed DNS resolution; source-based evidence instead comes directly from the connected GitHub repository.
- Read and respected the canonical design, implementation roadmap and local-core plan from repository files. The historical design recommends MIT OR Apache-2.0, while the project owner subsequently selected preparation of AGPL-3.0-only plus optional commercial licensing. This report does not amend the canonical design or any operative legal text.
- Machine-readable [lockfile inventory](lockfile-inventory-2026-10-13.json) preserves all parsed package names and versions. Counts are lockfile **records**, not unique vendors or binaries actually shipped.

## Observed tracked-source and contribution scope

| Evidence | Main | Newer development branch |
| --- | ---: | ---: |
| Total Git tree entries | 437 | 540 |
| Tracked files | 350 | 453 |
| Commit history reachable from ref | 268 | 661 |
| Commit author labels | Sohaib: 181; Tetherplane Automation: 87 | Sohaib: 573; muhamedsohaib: 1; Tetherplane Automation: 87 |
| Main divergence | baseline | 393 commits ahead, 120 changed files |
| Root LICENSE / Cargo.toml / both lockfiles | MIT OR Apache-2.0 | **Same blobs as main** |

GitHub reports **61 branch references**, including main and the licensing preparation branch, and 12 pull requests attributable to the owner's GitHub account at the time of inspection. All checked commit author labels on the two histories are the project owner or automation; **this is not proof of complete copyright ownership**. The remaining branches may contain unique or unmerged work and were not all inspected for source provenance. The newer candidate and default-branch Rust and pnpm lockfiles have identical SHA values.

The recursive tree contains no separately named `vendor`, `node_modules`, `NOTICE` or SBOM file and no tracked `.dll`, `.exe`, `.zip` or common image/font asset. A tree/path inventory is **not** a source-similarity analysis and says nothing about transitive runtime artifacts created during packaging.

## Exact lockfile dependency inventory

| Measure | Finding |
| --- | ---: |
| Cargo locked entries | 198 |
| Rust third-party registry entries | 191 |
| Rust local workspace entries | 7 |
| pnpm locked package entries | 179 |
| pnpm importers | 11 |
| Direct pnpm dependency placements (runtime + dev) | 42 |
| Unique non-Tetherplane direct npm package names (runtime + dev) | 13 |

Unique externally named direct pnpm packages: `@modelcontextprotocol/sdk`, `@types/chrome`, `@types/node`, `@types/oidc-provider`, `@types/ws`, `ajv`, `esbuild`, `jose`, `json-schema-to-typescript`, `oidc-provider`, `typescript`, `ws`, `zod`.

- `Cargo.lock` blob: `00a4c70f4d6619ac9dbca8e0a58d9c5d2957081d`. All 191 external Rust lockfile records are sourced from crates.io's registry index; the source field does **not** convey a license declaration.
- `pnpm-lock.yaml` blob: `b2d552249f995f07a605a240ed521aa4a91bbdb8`. Lockfile v9 stores registry/integrity information but **not** a verified license inventory. Both registries need a license/SBOM scanner and artifact-level validation.
- Lockfile records include platform-specific and development dependencies. They are not the Windows runtime dependency graph and must not be summed into a claim about shipped components.

### Exact-version license spot checks (partial, not clearance)

| Exact locked package | Registry/source-declared license verified in public package metadata | Evidence |
| --- | --- | --- |
| `uiautomation@0.25.1` | Apache-2.0 | https://docs.rs/crate/uiautomation/latest/source/Cargo.toml.orig |
| `winsafe@0.0.29` | MIT | https://docs.rs/crate/winsafe/latest/source/Cargo.toml |
| `portable-pty@0.9.0` | MIT | https://docs.rs/crate/portable-pty/latest/source/Cargo.toml.orig |
| `rustls@0.23.45` | Apache-2.0, MIT, ISC (alternative licenses, per upstream project) | https://docs.rs/crate/rustls/latest/source/README.md |
| `@modelcontextprotocol/sdk@1.30.0` | MIT | https://www.npmjs.com/package/%40modelcontextprotocol/sdk |
| `oidc-provider@9.12.2` | MIT | https://www.npmjs.com/package/oidc-provider |

These **six** declared-license checks do not validate the other 364 registry records; they also do not verify each source artifact's notice files, sublicensing rights, transitive conditions or commercial-dual-license compatibility. Some direct packages such as `windows-win@3.0.0` remain unverified. The Apache Software Foundation explains Apache-2.0 compatibility with GPLv3 in one direction (https://apache.org/licenses/GPL-compatibility.html); counsel must evaluate the precise application to AGPL-covered components, bundling and proprietary alternative licensing.

## Windows packaging / notice gap — for investigation, **not** a proven violation

The inspected newer Windows packager (`scripts/package-windows.ps1`, lines ~83-87) copies `LICENSE-MIT` and `LICENSE-APACHE`, along with README/SECURITY/CONTRIBUTING, but does **not** explicitly copy the root umbrella `LICENSE` or construct a consolidated third-party `NOTICE`/SBOM. The installer (`scripts/install-windows.ps1`, lines ~91-99) likewise copies the two historic license texts.

The build uses `pnpm deploy --prod` for runtime modules. Third-party notices **may** exist in nested installed `node_modules` or produced artifacts; the actual ZIP and installed tree were not accessible and thus cannot be cleared or condemned. For any future AGPL release, add tests proving all required licenses/notices and corresponding-source instructions are included, **only after clearance**.

The public v0.1.0 Windows ZIP is a separate historical artifact released on 2026-09-26. Its archive contents have **not** been independently inspected in this audit. Its earlier MIT/Apache rights remain valid.

## Rights assessment and classification

| Area | Status | Reason |
| --- | --- | --- |
| Owner declaration | **Self-reported** | Individual claims personal project ownership and no known outside interests; signed chain-of-title, employment/client contract and logo rights unverified. |
| Default-branch contributor identities | **Preliminarily inventoried** | Main: 268 commits, only two displayed author identities, one automation label. |
| Newer release-candidate contributor identities | **Preliminarily inventoried** | 661 reachable commits, author names as above; unique side-branch histories remain open. |
| Third-party code similarity / copied snippets | **Not verified** | Full source-content license scan and provenance analysis still outstanding. |
| Dependency identification | **Lockfile entries enumerated** | 191 external Rust + 179 pnpm package records, not complete shipped SBOM. |
| License compatibility | **Blocked** | Six spot checks only; missing all-dependency metadata and legal review. |
| Windows release composition/NOTICE | **Blocked** | Leno offline, binary archive not extracted; nested licenses unknown. |
| Future AGPL and alternate proprietary grants | **Blocked** | Rights/ownership and compatibility questions unresolved, no operative documents. |

## Reproducible next audit on Leno (read-only first)

1. Explicitly select **Leno**. In `C:\Users\Sohaib\source\Tetherplane`, record `git status`, `git branch --show-current`, `git log --oneline --decorate -5`, and `git remote -v`. Do not touch Surface, Vaulter, RTX or another device.
2. Inspect all reachable branches/tags, contributor author/committer/co-author metadata, changes not reachable from main, copied/included third-party source, copyright notices and scripts; verify owner declaration against applicable contracts **offline**, outside public Git history.
3. Generate the full Rust dependency graph with `cargo metadata --locked --format-version 1`, then collect exact registry metadata/licenses and local source copies with a vetted scanner. Resolve all ambiguous, composite or incompatible SPDX expressions with documented evidence.
4. Resolve pnpm packages with `pnpm install --frozen-lockfile` in a disposable clean worktree, inventory actual installed runtime dependencies and LICENSE/NOTICE files using a vetted license/SBOM tool, and record build/dev/optional/platform filters. Avoid downloading/executing untrusted installers or scripts without review.
5. Inspect the exact v0.1.0 ZIP and a freshly built **nonpublished** future candidate in isolation, capturing filenames, license notices, checksums, nested `node_modules`, browser-extension assets and applicable corresponding-source paths. Keep old release unmodified.
6. Produce an attorney-reviewed component-to-rights-holder map, SPDX compatibility decisions, notice obligations and a future-version license applicability matrix. Do not edit operative license fields until every rights and legal gate passes.
7. Run repository CI/packaging gates for actual future changes only after failing compliance tests and implementation, then obtain separate explicit approval to merge or publish.

## Next deliverable / no implicit go-ahead

Full source/build/installed-runtime SBOM, third-party notice audit, clearance of all branch-only work destined for release, provenance/chain-of-title confirmation and professional legal sign-off. **Do not activate AGPL, alter LICENSE/metadata, merge main, tag a release, or contact third parties on the basis of this report.**

## 2026-10-13 addendum — historical artifact and metadata evidence obtained after initial report

The initial report above accurately described the first audit's access limitations **at that time**, but its claim that the historical v0.1.0 ZIP had not been inspected is now **superseded for that specific historical release**. The original GitHub Actions release artifact was subsequently recovered, its embedded Windows ZIP matched the SHA-256 in the public release and archived SHA256SUMS, and the full ZIP CRC/Node package license-file survey passed. See [release-v0.1.0-artifact-audit-2026-10-13.md](release-v0.1.0-artifact-audit-2026-10-13.md).

The [registry metadata report](registry-license-metadata-2026-10-13.md) also documents successful automated collection of exact-version license declarations for all **191** Rust and **179** npm lockfile records. **352** were identified by a narrow, conservative permissive-identifier allowlist; **17** other declarations require interpretation, plus **one** with a permissive **OR** alternative to LGPL. This is not a legal clearance or source-derived Windows Rust binary SBOM.

Leno remains offline. A fresh local checkout audit, actual linked-crate graph/notice inventory, future candidate release artifact, contributor rights evidence and counsel signoff remain blocked/outstanding. Existing MIT OR Apache-2.0 rights, release tags and root license remain unchanged.
