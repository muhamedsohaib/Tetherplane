# Tetherplane licensing transition — proposal, not an operative license

Status: PROPOSAL ONLY — legal and ownership review required before any license change.
Prepared: 2026-10-13.
Repository: https://github.com/muhamedsohaib/Tetherplane

## Verified current position

- The default branch contains a `LICENSE` that offers MIT OR Apache-2.0, with full `LICENSE-MIT` and `LICENSE-APACHE` texts; `Cargo.toml` uses `MIT OR Apache-2.0`.
- `v0.1.0` was publicly released on 2026-09-26 with a Windows ZIP and SHA256SUMS file.
- Both permissive licenses allow commercial reuse (subject to their conditions), including proprietary derivatives.
- Previously valid licenses granted for earlier versions cannot simply be rescinded by changing the default-branch license.
- Git history includes named and automation-authored commits. Verify who holds copyright in each copyrightable contribution and whether explicit relicensing/dual-license authorization is available.
- Third-party dependencies and any copied/derived third-party code remain subject to their own licensing.

## Objectives

1. Preserve provenance and compliant treatment of already published versions.
2. Maximize enforceable protection for future original code and branding.
3. Enable commercial licensing of future versions where ownership rights allow.
4. Avoid false claims that all past clones are prohibited, that commercial use requires permission under v0.1.0, or that a public repository can detect private copies.

## Decision options

### A. AGPL-3.0-only for future contributions + optional separately negotiated commercial license

Strong copyleft for covered future distributions and qualifying network interactions. AGPL permits commercial use: it does not categorically bar others from charging money. Dual licensing can offer customers different terms only to the extent the licensing party controls all rights needed to grant them. Review any mixed-origin files or contributions before applying. This option changes project openness/distribution expectations and needs explicit owner approval and legal review.

### B. Source-available commercial-restriction agreement for future original code

A bespoke/commercial-use-restricted or vetted source-available license can require permission for some commercial uses, but it would *not* satisfy the Open Source Definition. Seek competent counsel before adopting terms, and do not impose restrictions on code owned by others or already-licensed copies.

### C. Keep MIT OR Apache-2.0 and monetize hosted/enterprise services

Maximizes permissive adoption, but cannot bar compliant commercial reuse. Protect branding separately using a clear trademark/name-and-logo use policy.

## Recommended bounded implementation after approval

1. Audit provenance, authorship, contributors, incorporated code, manifest license fields, and published releases.
2. Pick one future-license strategy, effective boundary (new tagged version or clearly separated new files), copyright-holders, and commercial-contact owner.
3. Obtain necessary contributor/rights-holder permissions and counsel review.
4. Draft future operative LICENSE, file headers, manifest SPDX expressions, NOTICE, trademark guidelines, contributor guidance, distribution documentation and compatibility notices. Do not overwrite third-party component licenses.
5. Write tests that enumerate license declarations, ensure intended distribution artifacts include notices, and prevent contradictory SPDX statements.
6. Run full Rust and TypeScript gates plus packaging smoke tests; publish only with explicit approval.
7. Maintain historical release tags and license text intact. Do not rewrite published history.

## Decision gate (no unilateral change)

Explicitly choose:
- **A**: AGPLv3 for eligible future code with separate commercial agreements; or
- **B**: source-available commercial restrictions for eligible future code; or
- **C**: stay permissive.

Legal/compliance review and confirmation of rights in all affected code are prerequisites to an operative license change.

## Public reuse search — preliminary evidence

On 2026-10-13, GitHub repository metadata showed 0 public forks and 0 stars. Repository-name searches for Tetherplane primarily surfaced the author's own Tetherplane and private tetherplane-relay repositories. Exact distinctive strings (`SemanticSnapshotEngine` with `stale_reference`, `capability must include a namespace separator`) surfaced the canonical repository in GitHub code search; no confirmed external copy was identified. These limited searches cannot reveal private clones, downloads, rebranded/modified copies, or unindexed repositories. Keep false positives (generic error strings, older unrelated 'tetherplane' naming) separate.

## Follow-up evidence collection

- Owner-only GitHub Insights > Traffic: https://github.com/muhamedsohaib/Tetherplane/graphs/traffic (rolling ~14 day views/clones; not identities).
- Retain Git commit history, the v0.1.0 tag, release asset checksums, license files, dated documentation, and attributable authorship records.
- Re-run publicly searchable exact-snippet, GitHub/GitLab/Codeberg, npm, crates.io, PyPI, MCP registries/marketplaces and domain searches periodically, comparing substantial code similarities rather than name alone.
- Preserve URLs, timestamps, source snapshots and side-by-side diffs before alleging infringement.
- Lack of public findings is not proof no private reuse occurred.
