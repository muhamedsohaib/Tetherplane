# Registry license declaration audit — 2026-10-13

> **PRELIMINARY AND NON-OPERATIVE. This is NOT legal clearance, a license change, or a complete release SBOM.** The current operative project license remains MIT OR Apache-2.0; the future AGPL-3.0-only/commercial transition is still subject to the rights audit, exact release/version scope, professional counsel and explicit approval.

## Collection provenance and verification

- Reproducible read-only collector: [scripts/audit_third_party_licenses.py](../../scripts/audit_third_party_licenses.py).
- Regression tests: [tests/legal/test_registry_license_evidence.py](../../tests/legal/test_registry_license_evidence.py).
- **Successful final workflow:** https://github.com/muhamedsohaib/Tetherplane/actions/runs/38450704018 (head at `23af6f94d9f7062102297758414c5fe8bdfffe13`). Workflow passed with unit tests and collected public metadata. An earlier failed run exposed a real pnpm parser issue; a failing nested-metadata regression test was added, the parser fixed, and the follow-up run passed.
- Workflow artifact: `licensing-registry-evidence`. Its `licensing-registry-evidence.json` lists each exact-version registry metadata response/license expression plus evidence URL. This run artifact is subject to GitHub Actions retention (configured 30 days).
- Parsed input SHA-256: `Cargo.lock` `3dbd7d193c56536af6b6c410ff24b98da9ec379997c5e1b002438e04f01a76e9`; `pnpm-lock.yaml` `11c9734eb75e8fac36287cbcc0c716e73c1da0391a565c464de9c855936e548a`.
- All **191 Rust crates** and **179 pnpm registry packages** were fetched from their public registry APIs. **No HTTP fetch failures or missing responses** in this run.

## Evidence summary

| Registry metadata result | Exact-version entries |
| --- | ---: |
| Rust crates.io declarations | 191 |
| npm registry declarations | 179 |
| **Total obtained** | **370** |
| Straightforward declared permissive expressions under the conservative automated allowlist | **352** |
| Declared expressions marked ambiguous for manual review | **17** |
| One expression with an **optional** copyleft choice alongside permissive alternatives | **1** |

These are *license declarations from registries*, not validated complete project/component notices or evidence of which libraries were statically linked into `tetherd.exe`. The automatic allowlist is deliberately narrow, so a manual-review classification does **not** prove a restrictive or incompatible license.

## The 18 manual-review entries

| Declaration family | Locked crate(s) | Meaning / follow-up |
| --- | --- | --- |
| Slash-form `MIT/Apache-2.0` or `Apache-2.0/MIT` | bitflags 1.3.2; downcast-rs 1.2.1; shared_library 0.1.9; shell-words 1.1.1; version_check 0.9.5; winapi 0.3.9; winapi-i686-pc-windows-gnu 0.4.0; winapi-x86_64-pc-windows-gnu 0.4.0 | Historically common alternative-license notation; confirm source notice and correct SPDX normalization. |
| `Unlicense/MIT` | same-file 1.0.6; walkdir 2.5.0 | Confirm underlying choice and copyright/source notices. |
| `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | linux-raw-sys 0.12.1; rustix 1.1.5; wasi 0.11.1+wasi-snapshot-preview1 | Multiple alternatives include plain Apache and MIT; select/verify legally appropriate option and source obligations. |
| `BSL-1.0` | error-code 3.4.0; windows-win 3.0.0 | **BSL-1.0 is the Boost Software License 1.0, not a Business Source License commercial restriction.** Verify actual upstream files. Official SPDX: https://spdx.org/licenses/BSL-1.0 . |
| `CDLA-Permissive-2.0` | webpki-roots 0.26.11 and 1.0.9 | A **data** license (Community Data License Agreement Permissive 2.0), requiring separate treatment for the bundled root-certificate data and its attribution/source obligations. Official SPDX: https://spdx.org/licenses/CDLA-Permissive-2.0.html . |
| `MIT OR Apache-2.0 OR LGPL-2.1-or-later` | r-efi 6.0.0 | **The LGPL option is not mandatory**: this expression offers MIT and Apache alternatives. The collector distinguishes `review-alternative-copyleft` from a mandatory copyleft declaration. Verify upstream license choice and notice retention. |

None of these 18 declarations, standing alone, establishes that adopting AGPL for future owned code is impossible. Equally, declared MIT/Apache terms for a dependency do not automatically authorize the Tetherplane owner to sell proprietary licenses to third-party code. Counsel must confirm the future combined/repackaged distribution terms, patent rights and source obligations.

## Difference from the actual Windows ZIP

The separately checksum-verified historical [v0.1.0 binary ZIP audit](release-v0.1.0-artifact-audit-2026-10-13.md) found **190 installed Node package instances** (187 third-party, three internal), which are not the same as the **179 potential pnpm lockfile registry records**. The lockfile includes development/platform dependencies; the ZIP deploys duplicate Node module trees and filters dependencies. The Rust lockfile includes crates that may not actually be statically linked in the Windows binary. A reproducible build and release-derived SBOM are needed to establish exactly what shipped.

## Remaining release blockers

1. Produce artifact-to-source Rust dependency graph/SBOM for exact `tetherd.exe` and resolve component-level source/notice obligations.
2. Confirm rights in all owned/derived sources across branches, employment/client context and any imported code; the owner's personal ownership statement is self-reported.
3. Review upstream license texts and third-party notice terms of all relevant binary constituents, especially CDLA root data and mixed SPDX forms.
4. Approve a future version-specific AGPL map and properly cleared alternative commercial grants through qualified counsel.
5. Run fresh full repository and Windows packaging gates on **Leno**; the standard CI currently fails Rust Clippy 1.99 `assert_is_empty` diagnostics at two test sites. This is independent of the non-operative registry audit workflow success.
6. Obtain final explicit owner permission before changing any operative license, merging, tagging, publishing or contacting outside parties.

**No operative LICENSE, release, main branch or marketplace publication was changed by this audit.**
