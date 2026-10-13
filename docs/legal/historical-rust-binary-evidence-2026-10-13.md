# Historical v0.1.0 Windows Rust binary / dependency graph — 2026-10-13

> **NON-OPERATIVE EVIDENCE, NOT LEGAL OR LINKAGE CLEARANCE.** This document does not replace MIT OR Apache-2.0, alter released binaries, grant commercial rights, or approve any AGPL change. This is a retrospective static read-only analysis.

## Reproducible evidence

- GitHub Actions [historical binary workflow](https://github.com/muhamedsohaib/Tetherplane/actions/runs/38454286752) passed focused unit tests and inspected the authentic published Windows release ZIP against `v0.1.0:Cargo.lock`.
- An enhanced [Windows-target dependency graph workflow](https://github.com/muhamedsohaib/Tetherplane/actions/runs/38454652125) also passed with `cargo tree --locked --target x86_64-pc-windows-msvc -p tetherd --edges normal --prefix none --format '{p}'` from a detached checkout of `v0.1.0`.
- Implementation: [scripts/audit_binary_crates.py](../../scripts/audit_binary_crates.py); isolated [tests](../../tests/legal/test_binary_crates.py); [workflow](../../.github/workflows/legal-release-binary-evidence.yml).
- Workflow artifact `tetherplane-v010-binary-rust-evidence` contains `v0.1.0-binary-registry-path-evidence.json` and `v0.1.0-windows-cargo-tree.txt`. Workflow artifacts have a limited retention period (configured 30 days).
- Historical release ZIP SHA-256 (rechecked): `c909cdd78ac786ea2bcb4853841db9d52928c8ae54a99e3306c945aba1066e9c`.
- Historical `bin/tetherd.exe` SHA-256: `4f06b70ca4eefb2c1c5cfb70da71e1da45d02ece54d3f96b1220e16edcb2102a`. Size: 7,227,392 bytes. The executable **was not run**.

## Evidence reconciliation

| Level | Evidence | Packages |
| --- | --- | ---: |
| Historical locked Rust registry | `Cargo.lock` registry package entries | 191 |
| Historical Windows target | `cargo tree -p tetherd` packages, normal edges | **156** |
| Windows graph internal | Original Tetherplane workspace crates | **7** |
| Windows graph third party | External Rust crates in the resolution graph | **149** |
| Binary compiler source-path evidence | `.cargo\\registry\\src\\...\\crate-version\\...` occurrences | **464** |
| Unique third-party crate/version pairs with positive binary path indications | Compared against exact historical lockfile AND Windows Cargo tree | **46** |
| Positive crate/version pairs missing in either source graph | None | **0** |
| Third-party graph candidates lacking binary path evidence | Not proven present or absent from linked PE | **103** |

**Critical distinction:** The 149 crates in a Windows-target dependency *resolution graph* are not a certified statically linked constituent list. The graph can include proc macros and code optimized away. Conversely, a third-party crate may be linked while leaving no compiler path strings in the PE. The 46 positive observations are strong indications, not proof of complete linkage.

No debugger, disassembler, dynamic execution or Windows installation was performed. No source-to-binary reproducibility claim is made.

## Licensing metadata overlay (exact locked versions)

Registry metadata from the prior [370-entry audit](registry-license-metadata-2026-10-13.md) covers every one of the 149 external Windows graph records. Under the collector's **intentionally narrow** classification:

- **138** graph candidates: straightforward permissive registry declarations.
- **11** graph candidates: require manual review/normalization of declaration format or data licensing.
- Of the **46 positive binary path observations**, **44** had straightforward permissive declarations and **2** require interpretation (`shared_library@0.1.9` with `Apache-2.0/MIT`, and `walkdir@2.5.0` with `Unlicense/MIT`).

The 11 graph-level review cases are:

| Crate | Declared license | Audit action |
| --- | --- | --- |
| bitflags 1.3.2 | MIT/Apache-2.0 | Normalize older alternative-license notation; verify license text |
| downcast-rs 1.2.1 | MIT/Apache-2.0 | Same |
| error-code 3.4.0 | BSL-1.0 | Confirm Boost Software License, **not** Business Source License |
| same-file 1.0.6 | Unlicense/MIT | Verify license choice |
| shared_library 0.1.9 | Apache-2.0/MIT | Verify license choice and binary notice |
| shell-words 1.1.1 | MIT/Apache-2.0 | Same |
| walkdir 2.5.0 | Unlicense/MIT | Same |
| webpki-roots 0.26.11 | CDLA-Permissive-2.0 | Evaluate root-certificate data notices |
| webpki-roots 1.0.9 | CDLA-Permissive-2.0 | Evaluate root-certificate data notices |
| winapi 0.3.9 | MIT/Apache-2.0 | Normalize older license notation |
| windows-win 3.0.0 | BSL-1.0 | Confirm Boost license text and notice |

All 11 classifications indicate **manual work remaining**, not confirmed incompatibilities or copyright violations. They do not give Tetherplane the right to issue proprietary commercial grants over third-party works. Independently obtained prior MIT/Apache rights in Tetherplane v0.1.0 persist.

## Outstanding release gates

1. Actual compiler/linker and bundled-source/NOTICE-level SBOM, beyond Cargo resolution and debug path indicators, ideally verified by reproducing the historical Windows build and comparing constituents.
2. Evidence-backed review of license texts, copyright notices and attribution requirements, especially root-certificate data and linked Rust crates in release binaries.
3. Complete rights and provenance audit across fetched branch-only work and any external/AI/automated contributions; review contracts and title separately.
4. Fix unrelated Clippy failures on a dedicated verified code branch; run actual full release, acceptance, Windows packaging and installation gates on **Leno** when available.
5. Qualified legal clearance and explicit final owner approval before any operative license or commercial offer, merge, tag or publication.

See [full review index](README.md), [historical ZIP audit](release-v0.1.0-artifact-audit-2026-10-13.md), and [release gates](release-gates.md).
