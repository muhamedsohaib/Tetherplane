# Release publication gates (draft; requires configuration)

This document describes the proposed fail-closed tagged-release workflow. It is **not** a
production-release authorization. It is intentionally isolated on a draft PR.

## Boundaries

1. A `v*` tag triggers a Windows **read-only-token** build. The build and its CI
   tests cannot publish a GitHub Release. Action calls reference explicit commit SHAs.
   Rust 1.99.1, Node 22.23.3, and pnpm 10.34.5 are fixed inputs; Cargo.lock
   and pnpm-lock.yaml must be reviewed in the approved tag.
2. A separate `publish` job is the only job with `contents: write`. It has the
   GitHub Environment `tetherplane-release-approval`.
3. Before publishing, the job reads the environment via GitHub API and **fails
   closed** unless at least one `required_reviewers` protection rule exists
   with a nonempty reviewer list and **prevent_self_review: true**.
   The publish job explicitly requests `actions: read` solely to inspect
   these GitHub environment rules. An unavailable API, absent environment,
   missing protection, or missing permission must block publication.
4. The tagged commit must be an ancestor of `origin/main`; unmerged test
   branches cannot publish by tag alone.
5. The downloaded CI artifact's SHA-256 checksum must match its checksum file;
   the Windows package manifest's `source_commit` must match the tagged SHA.
6. The job requires an already-existing Git tag; no workflow creates tags or
   alters repository release settings.

## GitHub administrator setup BEFORE merging this workflow

In repository **Settings -> Environments**, create the environment named
`tetherplane-release-approval`. Configure its **required reviewers** to
include an authorized human independent of the release author; **enable
Prevent self-review** (mandatory for this workflow), and select
**Save protection rules**. Restrict deployment branches and
tags to the approved release process. Configure repository rulesets to
protect release tags against unauthorized creation or changes. Review the
permissions of the GitHub Actions token.

**Do not infer protections from this document:** verify the saved environment
rules, and perform a manual unapproved-tag exercise demonstrating that the
`publish` job remains blocked. The workflow's own environment check is an
additional guard, not a substitute for configured platform protections.

## Safe read-only environment check

On a machine already authenticated to GitHub CLI with **read-only access**
to the repository's deployment environments (for example Leno), run:

    powershell -NoProfile -File scripts/verify-release-environment.ps1

The script calls only a GitHub REST **GET** endpoint. It prints a sanitized
JSON receipt. \`PASS_ENVIRONMENT_REVIEWER_PREFLIGHT_ONLY\` verifies that
a required-reviewer rule exists and prevents self-review; it **never** means
a release is approved, a tag is protected, or a binary has been validated.

\`NO_GO\` indicates an absent or unprotected environment, inaccessible API,
missing \`gh\` login, or another prerequisite. Inspect the environment in
the GitHub repository Settings page and correct the configuration through
the repository administrator. Do not post GitHub access tokens or keys in
logs or chat. Separately verify protected release-tag rules and human
review approval.

## Required acceptance evidence

- Independent security review of the pinned action SHAs and Rust/Node/pnpm
  versions, plus vulnerability/license analysis of new Cargo dependencies.
- Normal CI on the exact combination of approved source PRs and secure
  release workflow; retain artifact SHA-256 and manifest provenance.
- Negative check: tagging an unmerged commit does not publish a release.
  Use a controlled nonproduction repository, not a real protected tag.
- Negative check: missing/empty required-reviewer protection cannot publish.
  Use a controlled nonproduction repository, not production environment edits.
- Human-approved release tag and protected environment approval.
- Windows clean-install/rollback acceptance on a new authorized device;
  for Vaulter, an agent-only canary, preserving the known-good binary,
  profile, credential files, OAuth clients, relay and TetherAuth service.
- Real verified binary `filesystem.copy` positive/negative cases within the
  original two workspace root constraints. No unrestricted process execution.

## Explicitly not covered

This is **not code signing**, a binary supply-chain attestation, off-host
TetherAuth recovery escrow, OAuth migration approval, a four-device live
acceptance result, or production rollback. Those remain independent release
gates. No protected service, identity key, OAuth/DCR client or user account
is changed by this draft.
