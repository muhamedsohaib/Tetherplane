# PRE-PUBLICATION Licensing Gates — NOTHING OPERATIVE AUTHORIZED

These are mandatory hold points for a prospective AGPL/commercial transition. All legal/rights/publication gates remain **open**.

## Gate 0: Preserve existing terms

- [x] Work limited to draft docs/legal documentation on a feature branch; no operative root license or release touched.
- [x] Keep old MIT/Apache releases, v0.1.0 tag, copyright notices and history intact.
- [ ] Revalidate current main and feature branch state before any merge.

## Gate 1: Rights and legal identity

- [ ] Complete source/contributor/employment/contractor/automation chain-of-title audit, including all relevant tags and branches.
- [ ] Obtain necessary permissions/assignments, including a rights mechanism for alternative commercial licensing.
- [ ] Identify legal licensor and applicable governing law; get qualified counsel's written clearance.

## Gate 2: Dependency and artifact compliance

- [ ] License-scan complete Cargo.lock, pnpm-lock.yaml, nested bundled dependencies, source assets, Docker and Windows installed runtime.
- [ ] Review AGPL compatibility, retained permissive notices, patent and third-party obligations with counsel.
- [ ] Verify AGPL network/source-delivery behavior for the actual agent/relay deployment model.

## Gate 3: Explicit version boundary and implementation

- [ ] Owner approves exact future effective version/commit and list of covered file/components.
- [ ] Place unmodified AGPL license text in approved operative location with accurate SPDX/copyright/legacy license map.
- [ ] Update project Cargo/JS metadata and docs consistently, preserving independently licensed material.
- [ ] Update Windows packaging and installer for real license/NOTICE shipping.
- [ ] Write failing compliance tests, implement minimum behavior, then confirm passing focused and full gates.

## Gate 4: Technical verification

- [ ] cargo fmt --all -- --check
- [ ] cargo clippy --workspace --all-targets -- -D warnings
- [ ] cargo test --workspace
- [ ] pnpm -r typecheck && pnpm -r test && pnpm -r build
- [ ] Run tests/release/windows-package-smoke.ps1 and inspect produced ZIP notices and corresponding source.
- [ ] Record Leno environment, current commit SHA, output checksums and all test results without printing credentials.

## Gate 5: Commercial and brand program

- [ ] Counsel-approved commercial license and licensor signing authority.
- [ ] Lawyer-reviewed contributor-intake/CLA or assignment process.
- [ ] Separately vetted and approved trademark guidance if pursued.

## Gate 6: Owner publication authorization

- [ ] Independent legal sign-off for exact operative license, commercial draft and current dependencies.
- [ ] Explicit owner approval to merge, tag, release and separately to communicate/publish marketplace listings.
- [ ] Normal reviewed feature-branch merge; never rewrite published commits or force-push main.

## PREPARATION-ONLY verification possible today

Compare main..feature for changed paths. Only docs/legal/** may differ. Read back all new files and require prominent DRAFT/NOT OPERATIVE messages. Verify root LICENSE, LICENSE-MIT, LICENSE-APACHE and Cargo.toml remain unchanged. Docs-only checks do **not** replace release tests.

**STOP:** Any unchecked legal, rights, compatibility, source-compliance or final-approval gate means the operative switch must not be published.
