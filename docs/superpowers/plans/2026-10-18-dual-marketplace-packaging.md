# Dual Marketplace Packaging Implementation Plan

> **For agentic workers:** Use strict test-driven development, verify the exact artifact before completion, and keep marketplace submissions separately reviewed.

**Goal:** Prepare accurately branded, reproducible `tetherplane` packages for Microsoft Store and Agensi without implying Store certification or public availability.

**Architecture:** Windows Store delivery remains native Rust `tetherd` plus a Store-compatible launcher and local pairing lifecycle, not a second MCP backend. Agensi delivery is a declarative `SKILL.md` bundle teaching existing authenticated MCP clients to use the six-tool surface; it never packages device binaries or credentials. Both are sourced from the canonical GitHub repository and use a single display name `tetherplane`.

**Tech Stack:** Rust, PowerShell, Windows SDK MakeAppx, GitHub Actions, Python stdlib ZIP packaging, YAML frontmatter.

**Spec:** `docs/superpowers/specs/2026-09-17-tetherplane-design.md`; `docs/superpowers/plans/2026-09-17-tetherplane-implementation-roadmap.md`; `docs/superpowers/plans/2026-09-17-tetherplane-local-core-plan.md`; `docs/superpowers/plans/2026-10-18-windows-sac-msix-feasibility.md`.

## Global Constraints

- Exact public name `tetherplane` (one lowercase word), no "Native Windows" or test suffix in customer-facing metadata.
- Exactly six provider-neutral MCP tools: `device`, `files`, `process`, `browser`, `desktop`, `batch`.
- Default `background_only`; never widen policies, touch foreign resources, copy credentials or bypass Windows application-control trust.
- Never publish a Store listing, Agensi listing, product release or paid offering without explicit owner approval.
- Do not invent a public relay endpoint or imply that private `vaulter.tailf65eba.ts.net` is a community endpoint.
- Do not conflate a documented future distribution mechanism with an operationally verified installer.
- Preserve original two uploaded brand references; no logo redesign or generated imagery.
- Only GitHub and Leno are canonical project sources; local sandbox files are transient deliverable staging.

## Review Focus

1. An unconnected agent with no configured tetherplane MCP must stop with a clear connection prerequisite, never fabricate results.
2. A permission_denied or approval_required response is an enforced security boundary, not an error to evade or retry via an unrestricted tool.
3. Repackaging must exclude credential files, token-looking content, relay secrets, arbitrary scripts, and path-traversal ZIP names.
4. Developer MSIX must not be passed off as Store-signed, installed, or compatible with Smart App Control before certification and live acceptance.
5. Manifest public-facing name must be `tetherplane` while Store publisher identity remains a separate Partner Center-provided prerequisite.

---

### Task 1: Agensi skill contract, tests and package

**Files**
- Create: `distribution/agensi/tetherplane/SKILL.md`
- Create: `distribution/agensi/tetherplane/agents/openai.yaml`
- Create: `distribution/agensi/tetherplane/references/mcp-contract.md`
- Create: `distribution/agensi/listing.md`
- Create: `scripts/package-agensi-skill.py`
- Create: `tests/distribution/test_agensi_skill.py`

**Interface:** `python scripts/package-agensi-skill.py --source distribution/agensi/tetherplane --output dist/agensi/skill.zip`.

- [ ] Write test for SKILL.md name, description and six-tool contract; verify RED.
- [ ] Write test for safe ZIP contents, deterministic output and secret-file rejection; verify RED.
- [ ] Implement minimal skill and packager; rerun both targeted tests.
- [ ] Run skill-creator validator and inspect extracted ZIP; compare with repo content.
- [ ] Publish only a private CI artifact (not a public Agensi listing).

### Task 2: Windows Store submission metadata and brand guard

**Files**
- Create: `distribution/windows-store/listing.md`
- Create: `tests/release/windows-store-brand.Tests.ps1`
- Modify: `scripts/package-windows-store-msix.ps1` only after a failing test for exact display names/branding.

- [ ] Test exact `tetherplane` display name and placeholder identity in development; verify RED.
- [ ] Implement minimal public display-name corrections while retaining prototype publisher and unsigned developer status; verify GREEN.
- [ ] Preserve original brand assets as separate submission inputs. Do not invent icons, screenshots or a certified Store identity.
- [ ] Maintain existing Windows feasibility + provenance gates; run Windows CI.

### Task 3: CI submission-kit reproducibility and handoff

**Files**
- Create: `.github/workflows/agensi-skill-package.yml`
- Document Store and Agensi external review requirements in the channel listing docs.
- [ ] Verify CI can package/validate a local `skill.zip` without network/credentials.
- [ ] Verify MSIX focused gate remains green on new branch.
- [ ] Inspect artifacts, hashes and archive paths.
- [ ] Open draft PR stacked on existing MSIX feasibility branch.

## Separate launch blockers (never marked done by packaging CI)

- Native Store launcher needs locally protected per-device startup configuration, consented pairing, and a verified application lifecycle. Raw `tetherd.exe` requires command-line arguments and is not yet a working Store-launched app.
- Microsoft Partner Center publisher and package identity, privacy URL, authentic app screenshots, WACK and certified Store signature are required before submission. `runFullTrust` requires appropriate declaration/review.
- Agensi creator account, payouts where applicable, scan, listing review and final Publish action remain owner-approved manual gates.
- Windows SAC-On acceptance on Leno and other clean machines remains unverified.
